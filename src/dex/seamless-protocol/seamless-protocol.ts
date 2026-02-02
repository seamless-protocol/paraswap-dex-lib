import { Interface } from '@ethersproject/abi';
import { AsyncOrSync } from 'ts-essentials';
import {
  Token,
  Address,
  ExchangePrices,
  PoolPrices,
  AdapterExchangeParam,
  SimpleExchangeParam,
  PoolLiquidity,
  Logger,
  NumberAsString,
  DexExchangeParam,
} from '../../types';
import { SwapSide, Network, UNLIMITED_USD_LIQUIDITY } from '../../constants';
import * as CALLDATA_GAS_COST from '../../calldata-gas-cost';
import { getDexKeysWithNetwork } from '../../utils';
import { IDex } from '../../dex/idex';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { SeamlessProtocolData, DexParams } from './types';
import { SimpleExchange } from '../simple-exchange';
import { getLocalDeadlineAsFriendlyPlaceholder } from '../simple-exchange';
import { SeamlessProtocolConfig } from './config';
import { SeamlessProtocolEventPool } from './seamless-protocol-pool';
import LEVERAGE_ROUTER_ABI from '../../abi/seamless-protocol/LeverageRouter.json';
import LEVERAGE_ROUTER_RECIPIENT_WRAPPER_ABI from '../../abi/seamless-protocol/LeverageRouterRecipientWrapper.json';
import UNISWAP_V3_ROUTER_ABI from '../../abi/uniswap-v3/UniswapV3Router.abi.json';

const LEVERAGE_ROUTER_IFACE = new Interface(LEVERAGE_ROUTER_ABI);
const LEVERAGE_ROUTER_RECIPIENT_WRAPPER_IFACE = new Interface(
  LEVERAGE_ROUTER_RECIPIENT_WRAPPER_ABI,
);
const UNISWAP_V3_ROUTER_IFACE = new Interface(UNISWAP_V3_ROUTER_ABI);
const GAS_COST_PREVIEW_DEPOSIT = 75_000;
// Phase 1 pragmatic guardrail:
// In multi-leg SELL routes, the executor may patch the final leg's `fromAmount` to the actual balance after previous
// swaps. Since we precompute `flashLoanAmount` offchain (from previewDeposit), a small downward buffer reduces the risk
// of "borrowed too much debt" leading to Morpho repayment failures when the actual collateral input is slightly lower.
const FLASHLOAN_AMOUNT_BUFFER_BPS = 500n; // 5%

export class SeamlessProtocol
  extends SimpleExchange
  implements IDex<SeamlessProtocolData>
{
  protected eventPools: SeamlessProtocolEventPool;

  readonly hasConstantPriceLargeAmounts = false;
  // TODO: set true here if protocols works only with wrapped asset
  readonly needWrapNative = true;

  readonly isFeeOnTransferSupported = false;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(SeamlessProtocolConfig);

  logger: Logger;
  protected config: DexParams;

  constructor(
    readonly network: Network,
    readonly dexKey: string,
    readonly dexHelper: IDexHelper,
  ) {
    super(dexHelper, dexKey);
    this.config = SeamlessProtocolConfig[dexKey]?.[network];
    if (!this.config) {
      throw new Error(`${dexKey} config missing for network ${network}`);
    }
    this.logger = dexHelper.getLogger(dexKey);
    this.eventPools = new SeamlessProtocolEventPool(
      dexKey,
      network,
      dexHelper,
      this.logger,
    );
  }

  // Initialize pricing is called once in the start of
  // pricing service. It is intended to setup the integration
  // for pricing requests. It is optional for a DEX to
  // implement this function
  async initializePricing(blockNumber: number) {
    // TODO: complete me!
  }

  // Legacy: was only used for V5
  // Returns the list of contract adapters (name and index)
  // for a buy/sell. Return null if there are no adapters.
  getAdapters(side: SwapSide): { name: string; index: number }[] | null {
    return null;
  }

  // Returns list of pool identifiers that can be used
  // for a given swap. poolIdentifiers must be unique
  // across DEXes. It is recommended to use
  // ${dexKey}_${poolAddress} as a poolIdentifier
  async getPoolIdentifiers(
    srcToken: Token,
    destToken: Token,
    side: SwapSide,
    blockNumber: number,
  ): Promise<string[]> {
    // Phase 1: SELL mint leg only (collateral -> LT).
    if (side !== SwapSide.SELL) return [];

    const ltKey = destToken.address.toLowerCase();
    const market = this.config.marketsByLeverageToken[ltKey];
    if (!market || !market.enableSellMint) return [];

    const collateral =
      market.seamlessLeverageToken.collateralToken.toLowerCase();
    if (srcToken.address.toLowerCase() !== collateral) return [];

    // NOTE: blockNumber is unused for pool discovery (static config).
    return [`${this.dexKey}_${ltKey}`];
  }

  // Returns pool prices for amounts.
  // If limitPools is defined only pools in limitPools
  // should be used. If limitPools is undefined then
  // any pools can be used.
  async getPricesVolume(
    srcToken: Token,
    destToken: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    limitPools?: string[],
  ): Promise<null | ExchangePrices<SeamlessProtocolData>> {
    // Phase 1: SELL mint leg only (collateral -> LT).
    if (side !== SwapSide.SELL) return null;

    const ltKey = destToken.address.toLowerCase();
    const market = this.config.marketsByLeverageToken[ltKey];
    if (!market || !market.enableSellMint) return null;

    const collateral =
      market.seamlessLeverageToken.collateralToken.toLowerCase();
    if (srcToken.address.toLowerCase() !== collateral) return null;

    const poolId = `${this.dexKey}_${ltKey}`;
    if (limitPools && !limitPools.includes(poolId)) return null;

    const leverageRouter = market.seamlessPeriphery.leverageRouter;
    if (!leverageRouter) {
      this.logger.warn(
        `${this.dexKey}-${this.network}: leverageRouter missing in config for lt=${market.seamlessLeverageToken.leverageToken}`,
      );
      return null;
    }

    const leverageToken = market.seamlessLeverageToken.leverageToken;

    const prices: bigint[] = new Array(amounts.length);
    let lastDebt: bigint | null = null;

    // Build multicall params for non-zero amounts.
    const calls = amounts
      .map((amount, idx) => ({ amount, idx }))
      .filter(x => x.amount !== 0n)
      .map(({ amount, idx }) => ({
        target: leverageRouter,
        callData: LEVERAGE_ROUTER_IFACE.encodeFunctionData('previewDeposit', [
          leverageToken,
          amount.toString(),
        ]),
        decodeFunction: (returnData: any) => {
          const decoded = LEVERAGE_ROUTER_IFACE.decodeFunctionResult(
            'previewDeposit',
            returnData,
          );
          const preview = decoded[0];
          return {
            shares: BigInt(preview.shares.toString()),
            debt: BigInt(preview.debt.toString()),
          };
        },
        cb: (decoded: { shares: bigint; debt: bigint }) => {
          prices[idx] = decoded.shares;
          if (idx === amounts.length - 1) lastDebt = decoded.debt;
        },
      }));

    // Fill zeros upfront (including the conventional first 0 amount).
    for (let i = 0; i < amounts.length; i++) {
      if (amounts[i] === 0n) prices[i] = 0n;
    }

    // Execute in one multicall batch (may internally chunk).
    await this.dexHelper.multiWrapper.tryAggregate(true, calls, blockNumber);

    // Phase 1 shortcut: we only carry tx-building data for the last amount.
    const amountIn = amounts[amounts.length - 1] ?? 0n;
    if (amountIn !== 0n && lastDebt === null) {
      throw new Error(
        `${this.dexKey}-${this.network}: failed to compute flashLoanAmount for lt=${leverageToken}`,
      );
    }

    const rawFlashLoanAmount = lastDebt ?? 0n;
    const flashLoanAmount =
      rawFlashLoanAmount === 0n
        ? 0n
        : (rawFlashLoanAmount * (10_000n - FLASHLOAN_AMOUNT_BUFFER_BPS)) /
          10_000n;

    const data: SeamlessProtocolData = {
      leverageToken,
      amountIn,
      flashLoanAmount,
    };

    return [
      {
        unit: prices.length > 1 ? prices[1] : 0n,
        prices,
        data,
        poolAddresses: [leverageToken],
        exchange: this.dexKey,
        gasCost: GAS_COST_PREVIEW_DEPOSIT,
        poolIdentifiers: [poolId],
      },
    ];
  }

  // Returns estimated gas cost of calldata for this DEX in multiSwap
  getCalldataGasCost(
    poolPrices: PoolPrices<SeamlessProtocolData>,
  ): number | number[] {
    // TODO: update if there is any payload in getAdapterParam
    return CALLDATA_GAS_COST.DEX_NO_PAYLOAD;
  }

  // Encode params required by the exchange adapter
  // V5: Used for multiSwap, buy & megaSwap
  // V6: Not used, can be left blank
  // Hint: abiCoder.encodeParameter() could be useful
  getAdapterParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    _data: SeamlessProtocolData,
    _side: SwapSide,
  ): AdapterExchangeParam {
    throw new Error(
      `${this.dexKey} is V6-only; getAdapterParam (V5) is not supported`,
    );
  }

  async getDexParam(
    srcToken: Address,
    destToken: Address,
    srcAmount: NumberAsString,
    _destAmount: NumberAsString,
    _recipient: Address,
    data: SeamlessProtocolData,
    side: SwapSide,
  ): Promise<DexExchangeParam> {
    if (side !== SwapSide.SELL) {
      throw new Error(`${this.dexKey} Phase 1 supports SELL only`);
    }

    const ltKey = data.leverageToken.toLowerCase();
    const market = this.config.marketsByLeverageToken[ltKey];
    if (!market) {
      throw new Error(`${this.dexKey} unknown market lt=${data.leverageToken}`);
    }
    if (!market.enableSellMint) {
      throw new Error(
        `${this.dexKey} SELL mint is disabled for lt=${data.leverageToken}`,
      );
    }

    const collateralToken = market.seamlessLeverageToken.collateralToken;
    const leverageToken = market.seamlessLeverageToken.leverageToken;

    if (
      srcToken.toLowerCase() !== collateralToken.toLowerCase() ||
      destToken.toLowerCase() !== leverageToken.toLowerCase()
    ) {
      throw new Error(
        `${this.dexKey} Phase 1 supports only collateral->LT SELL (src=${srcToken}, dest=${destToken})`,
      );
    }

    // Phase 1: pricing carries only one flashLoanAmount (for a specific src amount).
    // getDexParam has no blockNumber, so we fail fast if tx-building tries to use a different srcAmount.
    if (BigInt(srcAmount) !== data.amountIn) {
      throw new Error(
        `${
          this.dexKey
        } tx amount mismatch (srcAmount=${srcAmount} != priced amountIn=${data.amountIn.toString()})`,
      );
    }

    const leverageRouter = market.seamlessPeriphery.leverageRouter;
    if (!leverageRouter) {
      throw new Error(
        `${this.dexKey} missing leverageRouter (Gate 0) for lt=${data.leverageToken}`,
      );
    }

    const leverageRouterRecipientWrapper =
      market.seamlessPeriphery.leverageRouterRecipientWrapper;
    if (!leverageRouterRecipientWrapper) {
      throw new Error(
        `${this.dexKey} missing leverageRouterRecipientWrapper (Gate 1) for lt=${data.leverageToken}`,
      );
    }

    // Gate 1: execute against a thin wrapper that:
    // - pulls collateral from the ParaSwap executor (`msg.sender`)
    // - calls LeverageRouter.deposit(...) as itself (so shares are minted to the wrapper)
    // - forwards minted shares to the per-leg `recipient`
    // - returns `sharesOut` as the first return value (returnAmountPos=0)
    //
    // Internal swapCalls (debtAsset -> collateral) are executed by the Seamless multicallExecutor during the flashloan
    // lifecycle. Phase 1: we only support WETH->wstETH via Uniswap V3 to keep the E2E harness deterministic.
    const debtToken = market.seamlessLeverageToken.debtToken;
    const swapCalls = this.buildDebtToCollateralSwapCalls({
      debtToken,
      collateralToken,
      multicallExecutor: market.seamlessPeriphery.multicallExecutor,
      flashLoanAmount: data.flashLoanAmount,
    });

    const exchangeData =
      LEVERAGE_ROUTER_RECIPIENT_WRAPPER_IFACE.encodeFunctionData(
        'depositToRecipient',
        [
          leverageToken,
          srcAmount,
          data.flashLoanAmount.toString(),
          // ParaSwap sets per-leg destAmount=1 for SELL; keep router minShares minimal and let Augustus enforce global slippage.
          '1',
          market.seamlessPeriphery.multicallExecutor,
          swapCalls,
          leverageRouter,
          _recipient,
          _recipient,
        ],
      );

    return {
      needWrapNative: this.needWrapNative,
      dexFuncHasRecipient: true,
      targetExchange: leverageRouterRecipientWrapper,
      exchangeData,
      // depositToRecipient(leverageToken, collateralFromSender, ...) => argIndex( collateralFromSender ) == 1 => 4 + 32*1 == 36
      // Avoid accidental matches inside nested dynamic bytes (swapCalls) by forcing the patch location.
      insertFromAmountPos: 36,
      // sharesOut is returned as the first return value
      returnAmountPos: 0,
    };
  }

  private buildDebtToCollateralSwapCalls(params: {
    debtToken: Address;
    collateralToken: Address;
    multicallExecutor: Address;
    flashLoanAmount: bigint;
  }): [Address, NumberAsString, string][] {
    // Phase 1: only support WETH -> wstETH on Mainnet (used by our E2E harness).
    // If/when we switch to a Balmy/defi-sdk based builder, this becomes dynamic.
    if (this.network !== Network.MAINNET) {
      throw new Error(
        `${this.dexKey} Gate 1 swapCalls only implemented for MAINNET`,
      );
    }

    const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'.toLowerCase();
    const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0'.toLowerCase();
    if (
      params.debtToken.toLowerCase() !== WETH ||
      params.collateralToken.toLowerCase() !== WSTETH
    ) {
      throw new Error(
        `${this.dexKey} Gate 1 swapCalls only supports WETH->wstETH (debt=${params.debtToken}, collateral=${params.collateralToken})`,
      );
    }

    // Uniswap V3 SwapRouter (mainnet) — deterministic onchain venue for the internal debt->collateral swap.
    const uniswapV3Router = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
    const approveData = this.erc20Interface.encodeFunctionData('approve', [
      uniswapV3Router,
      params.flashLoanAmount.toString(),
    ]);

    const swapData = UNISWAP_V3_ROUTER_IFACE.encodeFunctionData(
      'exactInputSingle',
      [
        {
          tokenIn: params.debtToken,
          tokenOut: params.collateralToken,
          // WETH/wstETH pools exist at 100/500/3000; pick 100 for best liquidity/lowest impact.
          fee: 100,
          // Keep the output on the multicall executor so `multicallAndSweep` can sweep it back to the router.
          recipient: params.multicallExecutor,
          deadline: getLocalDeadlineAsFriendlyPlaceholder(),
          amountIn: params.flashLoanAmount.toString(),
          amountOutMinimum: '0',
          sqrtPriceLimitX96: '0',
        },
      ],
    );

    return [
      [params.debtToken, '0', approveData],
      [uniswapV3Router, '0', swapData],
    ];
  }

  // This is called once before getTopPoolsForToken is
  // called for multiple tokens. This can be helpful to
  // update common state required for calculating
  // getTopPoolsForToken. It is optional for a DEX
  // to implement this
  async updatePoolState(): Promise<void> {
    // TODO: complete me!
  }

  // Returns list of top pools based on liquidity. Max
  // limit number pools should be returned.
  async getTopPoolsForToken(
    tokenAddress: Address,
    limit: number,
  ): Promise<PoolLiquidity[]> {
    const token = tokenAddress.toLowerCase();

    const pools: PoolLiquidity[] = [];

    for (const market of Object.values(this.config.marketsByLeverageToken)) {
      const lt = market.seamlessLeverageToken.leverageToken.toLowerCase();
      const collateral =
        market.seamlessLeverageToken.collateralToken.toLowerCase();

      // If token is collateral, it may map to multiple leverage tokens.
      if (token === collateral) {
        pools.push({
          exchange: this.dexKey,
          address: market.seamlessLeverageToken.leverageToken,
          connectorTokens: [
            {
              address: market.seamlessLeverageToken.leverageToken,
              decimals: 18,
              liquidityUSD: UNLIMITED_USD_LIQUIDITY,
            },
          ],
          liquidityUSD: UNLIMITED_USD_LIQUIDITY,
        });
        continue;
      }

      // If token is the leverage token, it maps to exactly one collateral token.
      if (token === lt) {
        pools.push({
          exchange: this.dexKey,
          address: market.seamlessLeverageToken.leverageToken,
          connectorTokens: [
            {
              address: market.seamlessLeverageToken.collateralToken,
              decimals: 18,
              liquidityUSD: UNLIMITED_USD_LIQUIDITY,
            },
          ],
          liquidityUSD: UNLIMITED_USD_LIQUIDITY,
        });
      }
    }

    return pools.slice(0, limit);
  }

  // This is optional function in case if your implementation has acquired any resources
  // you need to release for graceful shutdown. For example, it may be any interval timer
  releaseResources(): AsyncOrSync<void> {
    // TODO: complete me!
  }
}
