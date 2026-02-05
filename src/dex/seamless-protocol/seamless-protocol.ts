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
import { SeamlessProtocolConfig } from './config';
import { SeamlessProtocolEventPool } from './seamless-protocol-pool';
import LEVERAGE_ROUTER_ABI from '../../abi/seamless-protocol/LeverageRouter.json';
import DEX_LEVERAGE_ROUTER_ABI from '../../abi/seamless-protocol/DexLeverageRouter.json';
import { uint8ToNumber } from '../../lib/decoders';

const LEVERAGE_ROUTER_IFACE = new Interface(LEVERAGE_ROUTER_ABI);
const DEX_LEVERAGE_ROUTER_IFACE = new Interface(DEX_LEVERAGE_ROUTER_ABI);
const GAS_COST_PREVIEW_DEPOSIT = 75_000;
// Phase 1 pragmatic guardrail:
// In multi-leg SELL routes, the executor may patch the final leg's `fromAmount` to the actual balance after previous
// swaps. Since we precompute `flashLoanAmount` offchain (from previewDeposit), a small downward buffer reduces the risk
// of "borrowed too much debt" leading to Morpho repayment failures when the actual collateral input is slightly lower.
const FLASHLOAN_AMOUNT_BUFFER_BPS = 500n; // 5%
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

    const dexLeverageRouter = market.seamlessPeriphery.dexLeverageRouter;
    if (!dexLeverageRouter) {
      throw new Error(
        `${this.dexKey} missing dexLeverageRouter (Gate 1) for lt=${data.leverageToken}`,
      );
    }

    // Gate 1: execute against a thin wrapper that:
    // - pulls collateral from the ParaSwap executor (`msg.sender`)
    // - calls LeverageRouter.deposit(...) as itself (so shares are minted to the wrapper)
    // - forwards minted shares to the per-leg `recipient`
    // - returns `sharesOut` as the first return value (returnAmountPos=0)
    //
    // Internal swapCalls (debtAsset -> collateral) are executed by the Seamless multicallExecutor during the flashloan
    // lifecycle. Phase 1: build swapCalls via Velora Market API v6.2 and wrap the returned tx calldata as an
    // IMulticallExecutor.Call[] (nested Augustus).
    const debtToken = market.seamlessLeverageToken.debtToken;
    const swapCalls = await this.buildDebtToCollateralSwapCalls({
      debtToken,
      collateralToken,
      multicallExecutor: market.seamlessPeriphery.multicallExecutor,
      flashLoanAmount: data.flashLoanAmount,
    });

    const exchangeData = DEX_LEVERAGE_ROUTER_IFACE.encodeFunctionData(
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
      targetExchange: dexLeverageRouter,
      exchangeData,
      // depositToRecipient(leverageToken, collateralFromSender, ...) => argIndex( collateralFromSender ) == 1 => 4 + 32*1 == 36
      // Avoid accidental matches inside nested dynamic bytes (swapCalls) by forcing the patch location.
      insertFromAmountPos: 36,
      // sharesOut is returned as the first return value
      returnAmountPos: 0,
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

  private async buildDebtToCollateralSwapCalls(params: {
    debtToken: Address;
    collateralToken: Address;
    multicallExecutor: Address;
    flashLoanAmount: bigint;
  }): Promise<[Address, NumberAsString, string][]> {
    if (params.flashLoanAmount === 0n) return [];

    const fixtureKey = this.buildVeloraSwapFixtureKey({
      srcToken: params.debtToken,
      destToken: params.collateralToken,
      amount: params.flashLoanAmount,
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
        debtToken: params.debtToken,
        collateralToken: params.collateralToken,
        multicallExecutor: params.multicallExecutor,
        flashLoanAmount: params.flashLoanAmount,
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
        } Phase 1 forbids internal swaps with value>0 (value=${value.toString()})`,
      );
    }

    // Approval is executed by multicallExecutor.
    // Use a "reset to 0 then set" pattern for USDT-like tokens.
    const approveZero = this.erc20Interface.encodeFunctionData('approve', [
      to,
      '0',
    ]);
    const approveAmount = this.erc20Interface.encodeFunctionData('approve', [
      to,
      params.flashLoanAmount.toString(),
    ]);

    const calls: [Address, NumberAsString, string][] = [
      [params.debtToken, '0', approveZero],
      [params.debtToken, '0', approveAmount],
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

  private buildVeloraSwapFixtureKey(params: {
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
      SwapSide.SELL,
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
        'Velora /swap fixtures used to build SeamlessProtocol internal leverage swapCalls (debtAsset -> collateral) deterministically in E2E.',
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
      if (!to || !data) {
        throw new Error(
          `${this.dexKey}-${this.network}: invalid fixture for key=${key} (missing txParams.to/data)`,
        );
      }
      map.set(key, {
        to: String(to),
        data: String(data),
        value: value !== undefined ? String(value) : undefined,
      });
    }

    return map;
  }

  private async fetchVeloraSwapTxParams(params: {
    debtToken: Address;
    collateralToken: Address;
    multicallExecutor: Address;
    flashLoanAmount: bigint;
  }): Promise<VeloraSwapTxParams> {
    const srcDecimals = await this.getTokenDecimals(params.debtToken);
    const destDecimals = await this.getTokenDecimals(params.collateralToken);

    // Phase 1: use Velora Market API v6.2 /swap endpoint to build a debtAsset->collateral internal route.
    // IMPORTANT: userAddress == receiver == multicallExecutor, because swap targets see msg.sender == multicallExecutor.
    const { data } = await axios.get(`${this.veloraApiUrl}/swap`, {
      params: {
        network: this.network.toString(),
        version: VELORE_VERSION,
        side: SwapSide.SELL,
        srcToken: params.debtToken,
        srcDecimals,
        destToken: params.collateralToken,
        destDecimals,
        amount: params.flashLoanAmount.toString(),
        userAddress: params.multicallExecutor,
        receiver: params.multicallExecutor,
        slippage: INTERNAL_SWAP_SLIPPAGE_BPS,
        // Keep Phase 1 conservative: avoid legs that introduce permit2 / native routing complexity.
        excludeDEXS: INTERNAL_SWAP_EXCLUDE_DEXS,
      },
      timeout: 30_000,
    });

    return {
      to: String(data?.txParams?.to ?? ''),
      data: String(data?.txParams?.data ?? ''),
      value: data?.txParams?.value,
    };
  }

  // This is called once before getTopPoolsForToken is
  // called for multiple tokens. This can be helpful to
  // update common state required for calculating
  // getTopPoolsForToken. It is optional for a DEX
  // to implement this
  async updatePoolState(): Promise<void> {
    // Phase 1: markets are static-config driven (no event pool), so there is nothing to update here.
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
    // Phase 1: best-effort cleanup to help Jest exit cleanly in long E2E runs.
    this.tokenDecimalsCache.clear();
    this.veloraSwapCallsCache.clear();
    return;
  }
}
