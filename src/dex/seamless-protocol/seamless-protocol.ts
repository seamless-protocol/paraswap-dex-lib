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
    // TODO: complete me!
    return [];
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
    // TODO: complete me!
    return null;
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

    // Phase 1: tx-building is intentionally not implemented yet for SeamlessProtocol. Pricing/types/config scaffolding
    // comes first; execution wiring will be added once the onchain venue surface is finalized.
    throw new Error(`${this.dexKey} getDexParam is not implemented yet`);
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
