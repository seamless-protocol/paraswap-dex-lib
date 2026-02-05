import { Interface } from '@ethersproject/abi';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { AsyncOrSync } from 'ts-essentials';
import {
  Token,
  Address,
  ExchangePrices,
  PoolPrices,
  AdapterExchangeParam,
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
import { SeamlessProtocolConfig } from './config';
import { SeamlessProtocolEventPool } from './seamless-protocol-pool';
import DEX_LEVERAGE_ROUTER_ABI from '../../abi/seamless-protocol/DexLeverageRouter.json';
import { uint8ToNumber } from '../../lib/decoders';

const DEX_LEVERAGE_ROUTER_IFACE = new Interface(DEX_LEVERAGE_ROUTER_ABI);
const GAS_COST_PREVIEW_DEPOSIT = 75_000;
const VELORE_VERSION = '6.2';
const DEFAULT_VELORA_API_URL = 'https://api.paraswap.io';
const INTERNAL_SWAP_SLIPPAGE_BPS = '100'; // 1%
const INTERNAL_SWAP_EXCLUDE_DEXS = 'Native,UniswapV4';
const VELORA_SWAP_FIXTURES_PATH_ENV = 'SEAMLESS_VELORA_SWAP_FIXTURES_PATH';
const VELORA_SWAP_FIXTURES_STRICT_ENV = 'SEAMLESS_VELORA_SWAP_FIXTURES_STRICT';
const VELORA_SWAP_FIXTURES_WRITE_ENV = 'SEAMLESS_VELORA_SWAP_FIXTURES_WRITE';
const VELORA_SWAP_FIXTURES_STRICT_DEFAULT = false;
type VeloraSwapTxParams = {
  to: Address;
  data: string;
  value?: NumberAsString;
  srcAmount?: NumberAsString;
};

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
  private readonly veloraApiUrl: string;
  private readonly tokenDecimalsCache = new Map<string, number>();
  private readonly veloraSwapFixturesPath?: string;
  private readonly veloraSwapFixtures?: Map<string, VeloraSwapTxParams>;
  private readonly veloraSwapFixturesStrict: boolean;
  private readonly veloraSwapFixturesWrite: boolean;
  private readonly veloraSwapCallsCache = new Map<
    string,
    [Address, NumberAsString, string][]
  >();
  private readonly veloraSwapQuoteCache = new Map<string, bigint>();

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
    // Used only for building the internal leverage swap route (debtAsset -> collateral) via Velora Market API v6.2.
    // Keep separate from E2E_TEST_ENDPOINT so local pricing can still be forced while internal swaps use the API.
    this.veloraApiUrl =
      process.env.VELORA_API_URL ||
      process.env.SEAMLESS_VELORA_API_URL ||
      DEFAULT_VELORA_API_URL;

    this.veloraSwapFixturesStrict =
      (process.env[VELORA_SWAP_FIXTURES_STRICT_ENV] ?? '') === '1' ||
      VELORA_SWAP_FIXTURES_STRICT_DEFAULT;
    this.veloraSwapFixturesWrite =
      (process.env[VELORA_SWAP_FIXTURES_WRITE_ENV] ?? '') === '1';
    const fixturesPath = process.env[VELORA_SWAP_FIXTURES_PATH_ENV];
    if (fixturesPath) {
      const resolvedPath = path.isAbsolute(fixturesPath)
        ? fixturesPath
        : path.resolve(process.cwd(), fixturesPath);
      this.veloraSwapFixturesPath = resolvedPath;
      this.veloraSwapFixtures = this.loadVeloraSwapFixtures(resolvedPath);
      this.logger.info(
        `${this.dexKey}-${this.network}: loaded ${this.veloraSwapFixtures.size} Velora /swap fixtures from ${resolvedPath}`,
      );
    } else if (this.veloraSwapFixturesWrite) {
      throw new Error(
        `${this.dexKey}-${this.network}: ${VELORA_SWAP_FIXTURES_WRITE_ENV}=1 requires ${VELORA_SWAP_FIXTURES_PATH_ENV} to be set`,
      );
    } else if (this.veloraSwapFixturesStrict) {
      throw new Error(
        `${this.dexKey}-${this.network}: ${VELORA_SWAP_FIXTURES_STRICT_ENV}=1 requires ${VELORA_SWAP_FIXTURES_PATH_ENV} to be set`,
      );
    }
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
    const src = srcToken.address.toLowerCase();
    const dest = destToken.address.toLowerCase();

    const market =
      this.config.marketsByLeverageToken[dest] ??
      this.config.marketsByLeverageToken[src];
    if (!market) return [];

    if (!this.hasRequiredPeriphery(market)) return [];

    const lt = market.seamlessLeverageToken.leverageToken.toLowerCase();
    const collateral =
      market.seamlessLeverageToken.collateralToken.toLowerCase();

    const isMint = src === collateral && dest === lt;
    const isRedeem = src === lt && dest === collateral;
    if (!isMint && !isRedeem) return [];

    if (isMint && !this.isMintEnabled(market, side)) return [];
    if (isRedeem && !this.isRedeemEnabled(market, side)) return [];

    // NOTE: blockNumber is unused for pool discovery (static config).
    return [`${this.dexKey}_${lt}`];
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
    const src = srcToken.address.toLowerCase();
    const dest = destToken.address.toLowerCase();

    const market =
      this.config.marketsByLeverageToken[dest] ??
      this.config.marketsByLeverageToken[src];
    if (!market) return null;

    const leverageToken = market.seamlessLeverageToken.leverageToken;
    const lt = leverageToken.toLowerCase();
    const collateral =
      market.seamlessLeverageToken.collateralToken.toLowerCase();

    const isMint = src === collateral && dest === lt;
    const isRedeem = src === lt && dest === collateral;
    if (!isMint && !isRedeem) return null;

    if (isMint && !this.isMintEnabled(market, side)) return null;
    if (isRedeem && !this.isRedeemEnabled(market, side)) return null;
    if (!this.hasRequiredPeriphery(market)) return null;

    const poolId = `${this.dexKey}_${lt}`;
    if (limitPools && !limitPools.includes(poolId)) return null;

    const leverageRouter = market.seamlessPeriphery.leverageRouter;
    const dexLeverageRouter = market.seamlessPeriphery.dexLeverageRouter;
    if (!leverageRouter || !dexLeverageRouter) {
      this.logger.warn(
        `${this.dexKey}-${
          this.network
        }: periphery missing for lt=${leverageToken} (leverageRouter=${
          leverageRouter ?? 'missing'
        }, dexLeverageRouter=${dexLeverageRouter ?? 'missing'})`,
      );
      return null;
    }

    const prices: bigint[] = new Array(amounts.length);
    const flashLoans: bigint[] = new Array(amounts.length).fill(0n);
    let lastFlashLoan: bigint | null = null;

    const lastIdx = amounts.length - 1;
    const lastAmount = amounts[lastIdx] ?? 0n;

    // Fill zeros upfront (including the conventional first 0 amount).
    for (let i = 0; i < amounts.length; i++) {
      if (amounts[i] === 0n) prices[i] = 0n;
    }

    const useRawFlashLoan = isMint && side === SwapSide.BUY;

    const calls = amounts
      .map((amount, idx) => ({ amount, idx }))
      .filter(x => x.amount !== 0n)
      .map(({ amount, idx }) => {
        let fnName:
          | 'quoteMintFromCollateralExactIn'
          | 'quoteMintFromCollateralExactOut'
          | 'quoteRedeemToCollateralExactIn'
          | 'quoteRedeemToCollateralExactOut';

        if (isMint) {
          fnName =
            side === SwapSide.SELL
              ? 'quoteMintFromCollateralExactIn'
              : 'quoteMintFromCollateralExactOut';
        } else {
          fnName =
            side === SwapSide.SELL
              ? 'quoteRedeemToCollateralExactIn'
              : 'quoteRedeemToCollateralExactOut';
        }

        return {
          target: dexLeverageRouter,
          callData: DEX_LEVERAGE_ROUTER_IFACE.encodeFunctionData(fnName, [
            leverageToken,
            amount.toString(),
            leverageRouter,
          ]),
          decodeFunction: (returnData: any) => {
            const decoded = DEX_LEVERAGE_ROUTER_IFACE.decodeFunctionResult(
              fnName,
              returnData,
            );
            if (
              fnName === 'quoteMintFromCollateralExactIn' ||
              fnName === 'quoteMintFromCollateralExactOut'
            ) {
              const rawFlash = BigInt(decoded[2].toString());
              const bufferedFlash = BigInt(decoded[3].toString());
              return {
                price: BigInt(decoded[0].toString()),
                // For BUY, use the raw flashLoanAmount to avoid under-borrowing.
                flashLoanAmount: useRawFlashLoan ? rawFlash : bufferedFlash,
              };
            }
            if (fnName === 'quoteRedeemToCollateralExactIn') {
              return {
                price: BigInt(decoded[0].toString()),
                flashLoanAmount: BigInt(decoded[2].toString()),
              };
            }
            return {
              price: BigInt(decoded[0].toString()),
              flashLoanAmount: BigInt(decoded[2].toString()),
            };
          },
          cb: (decoded: { price: bigint; flashLoanAmount: bigint }) => {
            prices[idx] = decoded.price;
            flashLoans[idx] = decoded.flashLoanAmount;
            if (idx === lastIdx) lastFlashLoan = decoded.flashLoanAmount;
          },
        };
      });

    if (calls.length > 0) {
      await this.dexHelper.multiWrapper.tryAggregate(true, calls, blockNumber);
    }

    if (lastAmount !== 0n && lastFlashLoan === null) {
      throw new Error(
        `${this.dexKey}-${this.network}: failed to compute flashLoanAmount for lt=${leverageToken}`,
      );
    }

    // Redeem flows must account for collateral spent to buy debt for flashloan repayment.
    // Use a single Velora /swap quote for the last amount and scale linearly for other points.
    if (isRedeem && lastFlashLoan && lastFlashLoan > 0n) {
      const swapCostLast = await this.getVeloraSwapSourceAmount({
        side: SwapSide.BUY,
        srcToken: market.seamlessLeverageToken.collateralToken,
        destToken: market.seamlessLeverageToken.debtToken,
        multicallExecutor: market.seamlessPeriphery.multicallExecutor,
        amount: lastFlashLoan,
      });

      if (swapCostLast && swapCostLast > 0n) {
        for (let i = 0; i < amounts.length; i++) {
          if (amounts[i] === 0n) continue;
          const flashLoanAmount = flashLoans[i] ?? 0n;
          if (flashLoanAmount === 0n) continue;

          const estimatedCost =
            (flashLoanAmount * swapCostLast) / lastFlashLoan;

          if (side === SwapSide.SELL) {
            prices[i] =
              prices[i] > estimatedCost ? prices[i] - estimatedCost : 0n;
          } else {
            const desiredOut = amounts[i];
            const grossOut = desiredOut + estimatedCost;
            // Conservatively scale sharesIn requirement by the gross/desired ratio.
            prices[i] = (prices[i] * grossOut + desiredOut - 1n) / desiredOut;
            flashLoans[i] =
              (flashLoanAmount * grossOut + desiredOut - 1n) / desiredOut;
          }
        }

        if (side === SwapSide.BUY) {
          lastFlashLoan = flashLoans[lastIdx] ?? lastFlashLoan;
        }
      }
    }

    const amountIn =
      side === SwapSide.SELL ? lastAmount : prices[lastIdx] ?? 0n;
    const amountOut =
      side === SwapSide.SELL ? prices[lastIdx] ?? 0n : lastAmount;

    const data: SeamlessProtocolData = {
      leverageToken,
      amountIn,
      amountOut,
      flashLoanAmount: lastFlashLoan ?? 0n,
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
    destAmount: NumberAsString,
    recipient: Address,
    data: SeamlessProtocolData,
    side: SwapSide,
  ): Promise<DexExchangeParam> {
    const ltKey = data.leverageToken.toLowerCase();
    const market = this.config.marketsByLeverageToken[ltKey];
    if (!market) {
      throw new Error(`${this.dexKey} unknown market lt=${data.leverageToken}`);
    }

    const collateralToken = market.seamlessLeverageToken.collateralToken;
    const leverageToken = market.seamlessLeverageToken.leverageToken;
    const debtToken = market.seamlessLeverageToken.debtToken;

    const src = srcToken.toLowerCase();
    const dest = destToken.toLowerCase();
    const isMint =
      src === collateralToken.toLowerCase() &&
      dest === leverageToken.toLowerCase();
    const isRedeem =
      src === leverageToken.toLowerCase() &&
      dest === collateralToken.toLowerCase();
    if (!isMint && !isRedeem) {
      throw new Error(
        `${this.dexKey} unsupported pair (src=${srcToken}, dest=${destToken})`,
      );
    }
    if (isMint && !this.isMintEnabled(market, side)) {
      throw new Error(
        `${this.dexKey} mint is disabled for lt=${data.leverageToken} side=${side}`,
      );
    }
    if (isRedeem && !this.isRedeemEnabled(market, side)) {
      throw new Error(
        `${this.dexKey} redeem is disabled for lt=${data.leverageToken} side=${side}`,
      );
    }

    // Pricing carries only one flashLoanAmount (for a specific src amount).
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
        `${this.dexKey} missing leverageRouter for lt=${data.leverageToken}`,
      );
    }

    const dexLeverageRouter = market.seamlessPeriphery.dexLeverageRouter;
    if (!dexLeverageRouter) {
      throw new Error(
        `${this.dexKey} missing dexLeverageRouter for lt=${data.leverageToken}`,
      );
    }

    if (!market.seamlessPeriphery.multicallExecutor) {
      throw new Error(
        `${this.dexKey} missing multicallExecutor for lt=${data.leverageToken}`,
      );
    }

    if (isMint) {
      // Internal swapCalls (debtAsset -> collateral) executed by multicallExecutor.
      const swapCalls = await this.buildVeloraSwapCalls({
        srcToken: debtToken,
        destToken: collateralToken,
        multicallExecutor: market.seamlessPeriphery.multicallExecutor,
        amount: data.flashLoanAmount,
        side: SwapSide.SELL,
        approvalAmount: data.flashLoanAmount,
      });

      const minShares = side === SwapSide.SELL ? '1' : destAmount;

      const exchangeData = DEX_LEVERAGE_ROUTER_IFACE.encodeFunctionData(
        'depositToRecipient',
        [
          leverageToken,
          srcAmount,
          data.flashLoanAmount.toString(),
          minShares,
          market.seamlessPeriphery.multicallExecutor,
          swapCalls,
          leverageRouter,
          recipient,
          recipient,
        ],
      );

      return {
        needWrapNative: this.needWrapNative,
        dexFuncHasRecipient: true,
        targetExchange: dexLeverageRouter,
        exchangeData,
        // depositToRecipient(leverageToken, collateralFromSender, ...) => argIndex( collateralFromSender ) == 1 => 4 + 32*1 == 36
        // Avoid accidental matches inside nested dynamic bytes (swapCalls) by forcing the patch location.
        insertFromAmountPos: 36,
        // sharesOut is returned as the first return value for SELL
        returnAmountPos: side === SwapSide.SELL ? 0 : undefined,
      };
    }

    // Redeem: swap collateral -> debt to repay flash loan (BUY exact-out).
    const approvalAmount = data.amountOut;
    const swapCalls = await this.buildVeloraSwapCalls({
      srcToken: collateralToken,
      destToken: debtToken,
      multicallExecutor: market.seamlessPeriphery.multicallExecutor,
      amount: data.flashLoanAmount,
      side: SwapSide.BUY,
      approvalAmount,
    });

    const minCollateral = side === SwapSide.SELL ? '1' : destAmount;

    const exchangeData = DEX_LEVERAGE_ROUTER_IFACE.encodeFunctionData(
      'redeemToRecipient',
      [
        leverageToken,
        srcAmount,
        minCollateral,
        market.seamlessPeriphery.multicallExecutor,
        swapCalls,
        leverageRouter,
        recipient,
        recipient,
      ],
    );

    return {
      needWrapNative: this.needWrapNative,
      dexFuncHasRecipient: true,
      targetExchange: dexLeverageRouter,
      exchangeData,
      // redeemToRecipient(leverageToken, sharesIn, ...) => argIndex( sharesIn ) == 1 => 4 + 32*1 == 36
      insertFromAmountPos: 36,
      // collateralOut is returned as the first return value for SELL
      returnAmountPos: side === SwapSide.SELL ? 0 : undefined,
    };
  }

  private async getTokenDecimals(token: Address): Promise<number> {
    const key = token.toLowerCase();
    const cached = this.tokenDecimalsCache.get(key);
    if (cached !== undefined) return cached;

    const [decimals] = await this.dexHelper.multiWrapper.aggregate([
      {
        target: token,
        callData: '0x313ce567', // decimals()
        decodeFunction: uint8ToNumber,
      },
    ]);

    this.tokenDecimalsCache.set(key, decimals);
    return decimals;
  }

  private async buildVeloraSwapCalls(params: {
    srcToken: Address;
    destToken: Address;
    multicallExecutor: Address;
    amount: bigint;
    side: SwapSide;
    approvalAmount: bigint;
  }): Promise<[Address, NumberAsString, string][]> {
    if (params.amount === 0n) return [];

    const fixtureKey = this.buildVeloraSwapFixtureKey({
      side: params.side,
      srcToken: params.srcToken,
      destToken: params.destToken,
      amount: params.amount,
      userAddress: params.multicallExecutor,
      receiver: params.multicallExecutor,
      slippageBps: INTERNAL_SWAP_SLIPPAGE_BPS,
      excludeDEXS: INTERNAL_SWAP_EXCLUDE_DEXS,
    });
    const cached = this.veloraSwapCallsCache.get(fixtureKey);
    if (cached) return cached;

    const augustusV6 = this.augustusV6Address;
    if (!augustusV6) {
      throw new Error(`${this.dexKey} missing augustusV6Address in config`);
    }

    let txParams = this.veloraSwapFixtures?.get(fixtureKey);
    const loadedFromFixture = Boolean(txParams);
    if (!txParams) {
      if (this.veloraSwapFixtures && this.veloraSwapFixturesStrict) {
        throw new Error(
          `${this.dexKey} missing Velora /swap fixture for key=${fixtureKey}`,
        );
      }
      txParams = await this.fetchVeloraSwapTxParams({
        srcToken: params.srcToken,
        destToken: params.destToken,
        multicallExecutor: params.multicallExecutor,
        amount: params.amount,
        side: params.side,
      });
      if (this.veloraSwapFixturesWrite && this.veloraSwapFixturesPath) {
        this.persistVeloraSwapFixture(fixtureKey, txParams);
      }
    }
    if (!txParams?.to || !txParams?.data) {
      throw new Error(
        `${this.dexKey} invalid Velora /swap response (missing txParams.to/data)`,
      );
    }

    const to = String(txParams.to);
    if (to.toLowerCase() !== augustusV6.toLowerCase()) {
      throw new Error(
        `${this.dexKey} unexpected augustus target from /swap (to=${to}, expected=${augustusV6})`,
      );
    }

    const rawValue = txParams.value ?? '0';
    const value = BigInt(rawValue.toString());
    if (value !== 0n) {
      throw new Error(
        `${
          this.dexKey
        } internal swaps with value>0 are not supported (value=${value.toString()})`,
      );
    }

    // Approval is executed by multicallExecutor.
    // Use a "reset to 0 then set" pattern for USDT-like tokens.
    const approveZero = this.erc20Interface.encodeFunctionData('approve', [
      to,
      '0',
    ]);
    const approvalAmountFromTx =
      txParams.srcAmount !== undefined
        ? BigInt(txParams.srcAmount.toString())
        : null;
    const approvalAmount =
      approvalAmountFromTx ??
      (params.approvalAmount === 0n ? params.amount : params.approvalAmount);
    const approveAmount = this.erc20Interface.encodeFunctionData('approve', [
      to,
      approvalAmount.toString(),
    ]);

    const calls: [Address, NumberAsString, string][] = [
      [params.srcToken, '0', approveZero],
      [params.srcToken, '0', approveAmount],
      [to, '0', String(txParams.data)],
    ];
    this.veloraSwapCallsCache.set(fixtureKey, calls);
    // Reduce log noise: only log fixture sourcing when useful during local iteration.
    if (!loadedFromFixture) {
      this.logger.info(
        `${this.dexKey}-${this.network}: built internal swapCalls via live /swap (fixtureKey=${fixtureKey})`,
      );
    }
    return calls;
  }

  private async getVeloraSwapSourceAmount(params: {
    srcToken: Address;
    destToken: Address;
    multicallExecutor: Address;
    amount: bigint;
    side: SwapSide;
  }): Promise<bigint | null> {
    if (params.amount === 0n) return 0n;

    const fixtureKey = this.buildVeloraSwapFixtureKey({
      side: params.side,
      srcToken: params.srcToken,
      destToken: params.destToken,
      amount: params.amount,
      userAddress: params.multicallExecutor,
      receiver: params.multicallExecutor,
      slippageBps: INTERNAL_SWAP_SLIPPAGE_BPS,
      excludeDEXS: INTERNAL_SWAP_EXCLUDE_DEXS,
    });
    const cached = this.veloraSwapQuoteCache.get(fixtureKey);
    if (cached) return cached;

    let txParams = this.veloraSwapFixtures?.get(fixtureKey);
    if (!txParams) {
      if (this.veloraSwapFixtures && this.veloraSwapFixturesStrict) {
        throw new Error(
          `${this.dexKey} missing Velora /swap fixture for key=${fixtureKey}`,
        );
      }
      txParams = await this.fetchVeloraSwapTxParams({
        srcToken: params.srcToken,
        destToken: params.destToken,
        multicallExecutor: params.multicallExecutor,
        amount: params.amount,
        side: params.side,
      });
      if (this.veloraSwapFixturesWrite && this.veloraSwapFixturesPath) {
        this.persistVeloraSwapFixture(fixtureKey, txParams);
      }
    }

    if (!txParams?.srcAmount) {
      this.logger.warn(
        `${this.dexKey}-${this.network}: Velora /swap missing srcAmount for key=${fixtureKey}; redeem pricing will not be adjusted`,
      );
      return null;
    }

    const sourceAmount = BigInt(txParams.srcAmount.toString());
    this.veloraSwapQuoteCache.set(fixtureKey, sourceAmount);
    return sourceAmount;
  }

  private buildVeloraSwapFixtureKey(params: {
    side: SwapSide;
    srcToken: Address;
    destToken: Address;
    amount: bigint;
    userAddress: Address;
    receiver: Address;
    slippageBps: string;
    excludeDEXS: string;
  }): string {
    return [
      this.network.toString(),
      VELORE_VERSION,
      params.side,
      params.srcToken.toLowerCase(),
      params.destToken.toLowerCase(),
      params.amount.toString(),
      params.userAddress.toLowerCase(),
      params.receiver.toLowerCase(),
      params.slippageBps,
      params.excludeDEXS,
    ].join(':');
  }

  private persistVeloraSwapFixture(
    fixtureKey: string,
    txParams: VeloraSwapTxParams,
  ): void {
    if (!this.veloraSwapFixturesPath) return;
    if (!this.veloraSwapFixturesWrite) return;
    // Never write fixtures in CI.
    if (process.env.CI) return;

    let json: any = {};
    try {
      json = JSON.parse(fs.readFileSync(this.veloraSwapFixturesPath, 'utf8'));
    } catch {
      json = {};
    }

    if (!json || typeof json !== 'object') json = {};
    if (!json.fixtures || typeof json.fixtures !== 'object') {
      json.fixtures = {};
    }

    if (json.fixtures[fixtureKey]) return;

    json.meta = json.meta ?? {
      notes:
        'Velora /swap fixtures used to build SeamlessProtocol internal leverage swapCalls deterministically in E2E.',
      keyFormat:
        'network:version:side:srcToken:destToken:amount:userAddress:receiver:slippageBps:excludeDEXS',
    };

    // Keep a stable shape so fixtures can be migrated without changing the loader.
    json.fixtures[fixtureKey] = { txParams };

    fs.writeFileSync(
      this.veloraSwapFixturesPath,
      JSON.stringify(json, null, 2) + '\n',
    );

    // Update in-memory fixtures map for the current process.
    this.veloraSwapFixtures?.set(fixtureKey, txParams);

    this.logger.info(
      `${this.dexKey}-${this.network}: wrote Velora /swap fixture key=${fixtureKey} to ${this.veloraSwapFixturesPath}`,
    );
  }

  private loadVeloraSwapFixtures(
    resolvedPath: string,
  ): Map<string, VeloraSwapTxParams> {
    const raw = fs.readFileSync(resolvedPath, 'utf8');
    const json = JSON.parse(raw) as {
      fixtures?: Record<string, unknown>;
    };
    const fixtures = json.fixtures;
    if (!fixtures || typeof fixtures !== 'object') {
      throw new Error(
        `${this.dexKey}-${this.network}: invalid Velora swap fixtures file (missing 'fixtures') at ${resolvedPath}`,
      );
    }

    const map = new Map<string, VeloraSwapTxParams>();
    for (const [key, entry] of Object.entries(fixtures)) {
      const maybeTx = (entry as any)?.txParams ?? entry;
      const to = maybeTx?.to;
      const data = maybeTx?.data;
      const value = maybeTx?.value;
      const srcAmount = maybeTx?.srcAmount;
      if (!to || !data) {
        throw new Error(
          `${this.dexKey}-${this.network}: invalid fixture for key=${key} (missing txParams.to/data)`,
        );
      }
      map.set(key, {
        to: String(to),
        data: String(data),
        value: value !== undefined ? String(value) : undefined,
        srcAmount: srcAmount !== undefined ? String(srcAmount) : undefined,
      });
    }

    return map;
  }

  private async fetchVeloraSwapTxParams(params: {
    srcToken: Address;
    destToken: Address;
    multicallExecutor: Address;
    amount: bigint;
    side: SwapSide;
  }): Promise<VeloraSwapTxParams> {
    const srcDecimals = await this.getTokenDecimals(params.srcToken);
    const destDecimals = await this.getTokenDecimals(params.destToken);

    // Use Velora Market API v6.2 /swap endpoint to build the internal route.
    // IMPORTANT: userAddress == receiver == multicallExecutor, because swap targets see msg.sender == multicallExecutor.
    const { data } = await axios.get(`${this.veloraApiUrl}/swap`, {
      params: {
        network: this.network.toString(),
        version: VELORE_VERSION,
        side: params.side,
        srcToken: params.srcToken,
        srcDecimals,
        destToken: params.destToken,
        destDecimals,
        amount: params.amount.toString(),
        userAddress: params.multicallExecutor,
        receiver: params.multicallExecutor,
        slippage: INTERNAL_SWAP_SLIPPAGE_BPS,
        // Keep internal swap conservative: avoid legs that introduce permit2 / native routing complexity.
        excludeDEXS: INTERNAL_SWAP_EXCLUDE_DEXS,
      },
      timeout: 30_000,
    });

    return {
      to: String(data?.txParams?.to ?? ''),
      data: String(data?.txParams?.data ?? ''),
      value: data?.txParams?.value,
      srcAmount:
        data?.srcAmount !== undefined
          ? String(data?.srcAmount)
          : data?.priceRoute?.srcAmount !== undefined
          ? String(data?.priceRoute?.srcAmount)
          : undefined,
    };
  }

  // This is called once before getTopPoolsForToken is
  // called for multiple tokens. This can be helpful to
  // update common state required for calculating
  // getTopPoolsForToken. It is optional for a DEX
  // to implement this
  async updatePoolState(): Promise<void> {
    // Markets are static-config driven (no event pool), so there is nothing to update here.
    return;
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
      if (!this.hasRequiredPeriphery(market)) continue;

      const lt = market.seamlessLeverageToken.leverageToken.toLowerCase();
      const collateral =
        market.seamlessLeverageToken.collateralToken.toLowerCase();

      // If token is collateral, it may map to multiple leverage tokens.
      if (token === collateral) {
        if (
          !this.isMintEnabled(market, SwapSide.SELL) &&
          !this.isMintEnabled(market, SwapSide.BUY)
        ) {
          continue;
        }
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
        if (
          !this.isRedeemEnabled(market, SwapSide.SELL) &&
          !this.isRedeemEnabled(market, SwapSide.BUY)
        ) {
          continue;
        }
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
    // Best-effort cleanup to help Jest exit cleanly in long E2E runs.
    this.tokenDecimalsCache.clear();
    this.veloraSwapCallsCache.clear();
    this.veloraSwapQuoteCache.clear();
    return;
  }

  private isMintEnabled(
    market: DexParams['marketsByLeverageToken'][string],
    side: SwapSide,
  ): boolean {
    if (side === SwapSide.SELL) return market.enableSellMint;
    return market.enableBuyMint ?? market.enableSellMint;
  }

  private isRedeemEnabled(
    market: DexParams['marketsByLeverageToken'][string],
    side: SwapSide,
  ): boolean {
    if (side === SwapSide.SELL) return market.enableSellRedeem ?? false;
    return market.enableBuyRedeem ?? market.enableSellRedeem ?? false;
  }

  private hasRequiredPeriphery(
    market: DexParams['marketsByLeverageToken'][string],
  ): boolean {
    return Boolean(
      market.seamlessPeriphery.leverageRouter &&
        market.seamlessPeriphery.dexLeverageRouter &&
        market.seamlessPeriphery.multicallExecutor,
    );
  }
}
