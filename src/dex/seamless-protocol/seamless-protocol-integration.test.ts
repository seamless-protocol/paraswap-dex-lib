/* eslint-disable no-console */
import dotenv from 'dotenv';
dotenv.config();

import { Interface, Result } from '@ethersproject/abi';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { DummyDexHelper } from '../../dex-helper/index';
import { Network, SwapSide, UNLIMITED_USD_LIQUIDITY } from '../../constants';
import { BI_POWS } from '../../bigint-constants';
import { SeamlessProtocol } from './seamless-protocol';
import {
  checkPoolPrices,
  checkPoolsLiquidity,
  checkConstantPoolPrices,
} from '../../../tests/utils';
import { Tokens } from '../../../tests/constants-e2e';
import { SeamlessProtocolConfig } from './config';
import DEX_LEVERAGE_ROUTER_ABI from '../../abi/seamless-protocol/DexLeverageRouter.json';
import { formatUnits } from '@ethersproject/units';

/*
  README
  ======

  This test script adds tests for SeamlessProtocol general integration
  with the DEX interface. The test cases below are example tests.
  It is recommended to add tests which cover SeamlessProtocol specific
  logic.

  You can run this individual test script by running:
  `npx jest src/dex/<dex-name>/<dex-name>-integration.test.ts`

  (This comment should be removed from the final implementation)
*/

function getQuoterCalldata(
  exchangeAddress: string,
  readerIface: Interface,
  leverageToken: string,
  leverageRouter: string,
  amounts: bigint[],
  funcName: string,
) {
  return amounts.map(amount => ({
    target: exchangeAddress,
    callData: readerIface.encodeFunctionData(funcName, [
      leverageToken,
      amount.toString(),
      leverageRouter,
    ]),
  }));
}

function decodeQuoteResult(
  results: Result,
  readerIface: Interface,
  funcName: string,
) {
  return results.map(result => {
    const parsed = readerIface.decodeFunctionResult(funcName, result);
    let flashLoanIndex = 0;
    if (
      funcName === 'quoteMintFromCollateralExactIn' ||
      funcName === 'quoteMintFromCollateralExactOut'
    ) {
      flashLoanIndex = 3;
    } else if (
      funcName === 'quoteRedeemToCollateralExactIn' ||
      funcName === 'quoteRedeemToCollateralExactOut'
    ) {
      flashLoanIndex = 2;
    }
    return {
      price: BigInt(parsed[0].toString()),
      flashLoanAmount:
        flashLoanIndex > 0 ? BigInt(parsed[flashLoanIndex].toString()) : 0n,
    };
  });
}

const INTERNAL_SWAP_SLIPPAGE_BPS = '100';
const INTERNAL_SWAP_EXCLUDE_DEXS = 'Native,UniswapV4';
const VELORE_VERSION = '6.2';
const DEFAULT_VELORA_API_URL = 'https://api.paraswap.io';
let veloraFixturesCache: Record<string, any> | null = null;

function buildVeloraSwapFixtureKey(params: {
  network: Network;
  side: SwapSide;
  srcToken: string;
  destToken: string;
  amount: bigint;
  userAddress: string;
  receiver: string;
}) {
  return [
    params.network.toString(),
    VELORE_VERSION,
    params.side,
    params.srcToken.toLowerCase(),
    params.destToken.toLowerCase(),
    params.amount.toString(),
    params.userAddress.toLowerCase(),
    params.receiver.toLowerCase(),
    INTERNAL_SWAP_SLIPPAGE_BPS,
    INTERNAL_SWAP_EXCLUDE_DEXS,
  ].join(':');
}

async function getVeloraSwapSrcAmount(params: {
  network: Network;
  side: SwapSide;
  srcToken: string;
  destToken: string;
  amount: bigint;
  userAddress: string;
  receiver: string;
  srcDecimals: number;
  destDecimals: number;
}) {
  const fixturesPath =
    process.env.SEAMLESS_VELORA_SWAP_FIXTURES_PATH ??
    path.resolve(
      process.cwd(),
      'tests/fixtures/seamless-protocol/velora-swap.json',
    );
  const fixtureKey = buildVeloraSwapFixtureKey(params);

  if (fs.existsSync(fixturesPath)) {
    if (!veloraFixturesCache) {
      veloraFixturesCache =
        JSON.parse(fs.readFileSync(fixturesPath, 'utf8')).fixtures ?? {};
    }
    const entry = veloraFixturesCache[fixtureKey];
    const srcAmount =
      entry?.srcAmount ??
      entry?.txParams?.srcAmount ??
      entry?.priceRoute?.srcAmount;
    if (srcAmount) return BigInt(srcAmount.toString());
  }

  const veloraApiUrl =
    process.env.VELORA_API_URL ||
    process.env.SEAMLESS_VELORA_API_URL ||
    DEFAULT_VELORA_API_URL;
  const { data } = await axios.get(`${veloraApiUrl}/swap`, {
    params: {
      network: params.network.toString(),
      version: VELORE_VERSION,
      side: params.side,
      srcToken: params.srcToken,
      srcDecimals: params.srcDecimals,
      destToken: params.destToken,
      destDecimals: params.destDecimals,
      amount: params.amount.toString(),
      userAddress: params.userAddress,
      receiver: params.receiver,
      slippage: INTERNAL_SWAP_SLIPPAGE_BPS,
      excludeDEXS: INTERNAL_SWAP_EXCLUDE_DEXS,
    },
    timeout: 30_000,
  });

  const srcAmount =
    data?.srcAmount ?? data?.priceRoute?.srcAmount ?? data?.txParams?.srcAmount;
  return srcAmount ? BigInt(srcAmount.toString()) : null;
}

async function checkOnChainPricing(
  seamlessProtocol: SeamlessProtocol,
  dexLeverageRouterAddress: string,
  leverageRouterAddress: string,
  leverageToken: string,
  blockNumber: number,
  prices: bigint[],
  amounts: bigint[],
  funcName: string,
  opts?: {
    network?: Network;
    side?: SwapSide;
    collateralToken?: { address: string; decimals: number };
    debtToken?: { address: string; decimals: number };
    multicallExecutor?: string;
    isRedeem?: boolean;
  },
) {
  const readerIface = new Interface(DEX_LEVERAGE_ROUTER_ABI);
  const readerCallData = getQuoterCalldata(
    dexLeverageRouterAddress,
    readerIface,
    leverageToken,
    leverageRouterAddress,
    amounts.slice(1),
    funcName,
  );
  const readerResult = (
    await seamlessProtocol.dexHelper.multiContract.methods
      .aggregate(readerCallData)
      .call({}, blockNumber)
  ).returnData;

  const decoded = decodeQuoteResult(readerResult, readerIface, funcName);
  const expectedPrices = [0n].concat(decoded.map(d => d.price));
  const flashLoans = [0n].concat(decoded.map(d => d.flashLoanAmount));

  if (opts?.isRedeem && opts.side && opts.network) {
    const lastIdx = amounts.length - 1;
    const lastFlash = flashLoans[lastIdx] ?? 0n;
    if (
      lastFlash > 0n &&
      opts.collateralToken &&
      opts.debtToken &&
      opts.multicallExecutor
    ) {
      const swapCostLast = await getVeloraSwapSrcAmount({
        network: opts.network,
        side: SwapSide.BUY,
        srcToken: opts.collateralToken.address,
        destToken: opts.debtToken.address,
        amount: lastFlash,
        userAddress: opts.multicallExecutor,
        receiver: opts.multicallExecutor,
        srcDecimals: opts.collateralToken.decimals,
        destDecimals: opts.debtToken.decimals,
      });

      if (swapCostLast && swapCostLast > 0n) {
        for (let i = 0; i < amounts.length; i++) {
          if (amounts[i] === 0n) continue;
          const flashLoanAmount = flashLoans[i] ?? 0n;
          if (flashLoanAmount === 0n) continue;
          const estimatedCost = (flashLoanAmount * swapCostLast) / lastFlash;

          if (opts.side === SwapSide.SELL) {
            expectedPrices[i] =
              expectedPrices[i] > estimatedCost
                ? expectedPrices[i] - estimatedCost
                : 0n;
          } else {
            const desiredOut = amounts[i];
            const grossOut = desiredOut + estimatedCost;
            expectedPrices[i] =
              (expectedPrices[i] * grossOut + desiredOut - 1n) / desiredOut;
          }
        }
      }
    }
  }

  expect(prices).toEqual(expectedPrices);
}

async function testPricingOnNetwork(
  seamlessProtocol: SeamlessProtocol,
  network: Network,
  dexKey: string,
  blockNumber: number,
  srcToken: { address: string; decimals: number },
  destToken: { address: string; decimals: number },
  side: SwapSide,
  amounts: bigint[],
  leverageTokenAddress: string,
  leverageRouterAddress: string,
  dexLeverageRouterAddress: string,
  quoteFuncName: string,
  opts?: {
    isRedeem?: boolean;
    collateralToken?: { address: string; decimals: number };
    debtToken?: { address: string; decimals: number };
    multicallExecutor?: string;
  },
): Promise<{
  poolIdentifier: string;
  prices: bigint[];
  flashLoanAmount: bigint;
}> {
  const pools = await seamlessProtocol.getPoolIdentifiers(
    srcToken,
    destToken,
    side,
    blockNumber,
  );
  expect(pools.length).toBeGreaterThan(0);

  const poolPrices = await seamlessProtocol.getPricesVolume(
    srcToken,
    destToken,
    amounts,
    side,
    blockNumber,
    pools,
  );
  expect(poolPrices).not.toBeNull();
  if (seamlessProtocol.hasConstantPriceLargeAmounts) {
    checkConstantPoolPrices(poolPrices!, amounts, dexKey);
  } else {
    checkPoolPrices(poolPrices!, amounts, side, dexKey);
  }

  // Check if onchain pricing equals to calculated ones
  await checkOnChainPricing(
    seamlessProtocol,
    dexLeverageRouterAddress,
    leverageRouterAddress,
    leverageTokenAddress,
    blockNumber,
    poolPrices![0].prices,
    amounts,
    quoteFuncName,
    opts
      ? {
          ...opts,
          network,
          side,
        }
      : undefined,
  );

  const flashLoanAmount = poolPrices![0].data.flashLoanAmount;
  const poolIdentifier = poolPrices![0].poolIdentifiers?.[0];
  expect(poolIdentifier).toBeDefined();

  return {
    poolIdentifier: poolIdentifier!,
    prices: poolPrices![0].prices,
    flashLoanAmount,
  };
}

describe('SeamlessProtocol', function () {
  const dexKey = 'SeamlessProtocol';
  let blockNumber: number;
  let seamlessProtocol: SeamlessProtocol;

  describe('Mainnet', () => {
    const network = Network.MAINNET;
    const dexHelper = new DummyDexHelper(network);

    const tokens = Tokens[network];
    const marketConfig = SeamlessProtocolConfig[dexKey][network];
    const tokensByAddress = new Map(
      Object.values(tokens).map(t => [t.address.toLowerCase(), t]),
    );
    const tokenSymbolByAddress = new Map(
      Object.entries(tokens).map(([symbol, token]) => [
        token.address.toLowerCase(),
        symbol,
      ]),
    );

    const getTokenSymbol = (address: string) =>
      tokenSymbolByAddress.get(address.toLowerCase()) ?? 'N/A';

    const formatLiquidityUSD = (liquidityUSD: number | string) => {
      const numeric =
        typeof liquidityUSD === 'string' ? Number(liquidityUSD) : liquidityUSD;
      if (Number.isFinite(numeric) && numeric === UNLIMITED_USD_LIQUIDITY) {
        return `${liquidityUSD}(unlimited)`;
      }
      return `${liquidityUSD}`;
    };

    // TODO: Put here token Symbol to check against
    // Don't forget to update relevant tokens in constant-e2e.ts
    const srcTokenSymbol = 'wstETH';
    const destTokenSymbol = 'WSTETH-ETH-25x';

    const amountsForSell = [
      0n,
      1n * BI_POWS[tokens[srcTokenSymbol].decimals],
      2n * BI_POWS[tokens[srcTokenSymbol].decimals],
      3n * BI_POWS[tokens[srcTokenSymbol].decimals],
      4n * BI_POWS[tokens[srcTokenSymbol].decimals],
      5n * BI_POWS[tokens[srcTokenSymbol].decimals],
      6n * BI_POWS[tokens[srcTokenSymbol].decimals],
      7n * BI_POWS[tokens[srcTokenSymbol].decimals],
      8n * BI_POWS[tokens[srcTokenSymbol].decimals],
      9n * BI_POWS[tokens[srcTokenSymbol].decimals],
      10n * BI_POWS[tokens[srcTokenSymbol].decimals],
    ];

    const amountsForBuy = [
      0n,
      1n * BI_POWS[tokens[destTokenSymbol].decimals],
      2n * BI_POWS[tokens[destTokenSymbol].decimals],
      3n * BI_POWS[tokens[destTokenSymbol].decimals],
      4n * BI_POWS[tokens[destTokenSymbol].decimals],
      5n * BI_POWS[tokens[destTokenSymbol].decimals],
      6n * BI_POWS[tokens[destTokenSymbol].decimals],
      7n * BI_POWS[tokens[destTokenSymbol].decimals],
      8n * BI_POWS[tokens[destTokenSymbol].decimals],
      9n * BI_POWS[tokens[destTokenSymbol].decimals],
      10n * BI_POWS[tokens[destTokenSymbol].decimals],
    ];

    beforeAll(async () => {
      blockNumber = await dexHelper.web3Provider.eth.getBlockNumber();
      seamlessProtocol = new SeamlessProtocol(network, dexKey, dexHelper);
      if (seamlessProtocol.initializePricing) {
        await seamlessProtocol.initializePricing(blockNumber);
      }
    });

    it('1. Check Markets Mainnet', async () => {
      const markets = Object.values(marketConfig.marketsByLeverageToken);
      console.log(`SeamlessProtocol markets configured: ${markets.length}`);

      const rows = markets.map(market => {
        const lt = market.seamlessLeverageToken.leverageToken;
        const collateral = market.seamlessLeverageToken.collateralToken;
        const debt = market.seamlessLeverageToken.debtToken;

        return {
          ltSymbol: getTokenSymbol(lt),
          lt,
          collateralSymbol: getTokenSymbol(collateral),
          collateral,
          debtSymbol: getTokenSymbol(debt),
          debt,
          enableSellMint: market.enableSellMint,
          enableSellRedeem: market.enableSellRedeem ?? false,
          enableBuyMint: market.enableBuyMint ?? market.enableSellMint,
          enableBuyRedeem:
            market.enableBuyRedeem ?? market.enableSellRedeem ?? false,
        };
      });

      console.table(rows);

      expect(markets.length).toBeGreaterThan(0);
    });

    it('3. Check Sell Prices (all configured markets)', async function () {
      const formatAmount = (amount: bigint, decimals: number) => {
        // `formatUnits(1e18, 18)` => "1.0" (trim to "1")
        const formatted = formatUnits(amount.toString(), decimals);
        return formatted.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
      };

      const metaRows: Array<Record<string, unknown>> = [];

      for (const market of Object.values(marketConfig.marketsByLeverageToken)) {
        if (!market.enableSellMint) continue;

        const collateralToken =
          tokensByAddress.get(
            market.seamlessLeverageToken.collateralToken.toLowerCase(),
          ) ?? null;
        const leverageToken =
          tokensByAddress.get(
            market.seamlessLeverageToken.leverageToken.toLowerCase(),
          ) ?? null;
        const debtToken =
          tokensByAddress.get(
            market.seamlessLeverageToken.debtToken.toLowerCase(),
          ) ?? null;

        expect(collateralToken).not.toBeNull();
        expect(leverageToken).not.toBeNull();

        const unit = BI_POWS[collateralToken!.decimals];
        const sellAmounts = [
          0n,
          1n * unit,
          2n * unit,
          3n * unit,
          4n * unit,
          5n * unit,
          6n * unit,
          7n * unit,
          8n * unit,
          9n * unit,
          10n * unit,
        ];

        const leverageRouterAddress = market.seamlessPeriphery.leverageRouter;
        const dexLeverageRouterAddress =
          market.seamlessPeriphery.dexLeverageRouter;
        expect(leverageRouterAddress).toBeDefined();
        expect(dexLeverageRouterAddress).toBeDefined();

        const pricingSummary = await testPricingOnNetwork(
          seamlessProtocol,
          network,
          dexKey,
          blockNumber,
          collateralToken!,
          leverageToken!,
          SwapSide.SELL,
          sellAmounts,
          leverageToken!.address,
          leverageRouterAddress!,
          dexLeverageRouterAddress!,
          'quoteMintFromCollateralExactIn',
        );

        const ltSymbol = getTokenSymbol(
          market.seamlessLeverageToken.leverageToken,
        );
        const collateralSymbol = getTokenSymbol(
          market.seamlessLeverageToken.collateralToken,
        );
        const debtSymbol = getTokenSymbol(
          market.seamlessLeverageToken.debtToken,
        );

        // Print a per-amount curve table for this market
        const marketCurveRows = sellAmounts.map((amountIn, idx) => {
          const amountOut = pricingSummary.prices[idx] ?? 0n;
          return {
            amountIn: formatAmount(amountIn, collateralToken!.decimals),
            amountOut: formatAmount(amountOut, leverageToken!.decimals),
          };
        });

        console.log(`SELL curve: ${collateralSymbol} -> ${ltSymbol}`);
        console.table(marketCurveRows);

        // Meta summary row (full amount only)
        const fullAmountIn = sellAmounts[sellAmounts.length - 1] ?? 0n;
        const fullAmountOut =
          pricingSummary.prices[sellAmounts.length - 1] ?? 0n;
        metaRows.push({
          ltSymbol,
          collateralSymbol,
          debtSymbol,
          amountIn: formatAmount(fullAmountIn, collateralToken!.decimals),
          amountOut: formatAmount(fullAmountOut, leverageToken!.decimals),
          flashLoanAmount:
            debtToken === null
              ? pricingSummary.flashLoanAmount.toString()
              : formatAmount(
                  pricingSummary.flashLoanAmount,
                  debtToken.decimals,
                ),
          poolIdentifier: pricingSummary.poolIdentifier,
        });
      }

      console.log('SELL per-market summary (full amount only).');
      console.table(metaRows);
    });

    it('4. Check Buy Prices (all configured markets)', async function () {
      for (const market of Object.values(marketConfig.marketsByLeverageToken)) {
        if (!(market.enableBuyMint ?? market.enableSellMint ?? false)) continue;

        const collateralToken =
          tokensByAddress.get(
            market.seamlessLeverageToken.collateralToken.toLowerCase(),
          ) ?? null;
        const leverageToken =
          tokensByAddress.get(
            market.seamlessLeverageToken.leverageToken.toLowerCase(),
          ) ?? null;
        const debtToken =
          tokensByAddress.get(
            market.seamlessLeverageToken.debtToken.toLowerCase(),
          ) ?? null;

        expect(collateralToken).not.toBeNull();
        expect(leverageToken).not.toBeNull();
        expect(debtToken).not.toBeNull();

        const unit = BI_POWS[leverageToken!.decimals];
        const buyAmounts = [
          0n,
          1n * unit,
          2n * unit,
          3n * unit,
          4n * unit,
          5n * unit,
          6n * unit,
          7n * unit,
          8n * unit,
          9n * unit,
          10n * unit,
        ];

        const leverageRouterAddress = market.seamlessPeriphery.leverageRouter;
        const dexLeverageRouterAddress =
          market.seamlessPeriphery.dexLeverageRouter;
        expect(leverageRouterAddress).toBeDefined();
        expect(dexLeverageRouterAddress).toBeDefined();

        await testPricingOnNetwork(
          seamlessProtocol,
          network,
          dexKey,
          blockNumber,
          collateralToken!,
          leverageToken!,
          SwapSide.BUY,
          buyAmounts,
          leverageToken!.address,
          leverageRouterAddress!,
          dexLeverageRouterAddress!,
          'quoteMintFromCollateralExactOut',
        );
      }
    });

    it('5. Check Sell Redeem Prices (all configured markets)', async function () {
      for (const market of Object.values(marketConfig.marketsByLeverageToken)) {
        if (!(market.enableSellRedeem ?? false)) continue;

        const collateralToken =
          tokensByAddress.get(
            market.seamlessLeverageToken.collateralToken.toLowerCase(),
          ) ?? null;
        const leverageToken =
          tokensByAddress.get(
            market.seamlessLeverageToken.leverageToken.toLowerCase(),
          ) ?? null;
        const debtToken =
          tokensByAddress.get(
            market.seamlessLeverageToken.debtToken.toLowerCase(),
          ) ?? null;

        expect(collateralToken).not.toBeNull();
        expect(leverageToken).not.toBeNull();
        expect(debtToken).not.toBeNull();

        const unit = BI_POWS[leverageToken!.decimals];
        const sellAmounts = [
          0n,
          1n * unit,
          2n * unit,
          3n * unit,
          4n * unit,
          5n * unit,
          6n * unit,
          7n * unit,
          8n * unit,
          9n * unit,
          10n * unit,
        ];

        const leverageRouterAddress = market.seamlessPeriphery.leverageRouter;
        const dexLeverageRouterAddress =
          market.seamlessPeriphery.dexLeverageRouter;
        expect(leverageRouterAddress).toBeDefined();
        expect(dexLeverageRouterAddress).toBeDefined();

        await testPricingOnNetwork(
          seamlessProtocol,
          network,
          dexKey,
          blockNumber,
          leverageToken!,
          collateralToken!,
          SwapSide.SELL,
          sellAmounts,
          leverageToken!.address,
          leverageRouterAddress!,
          dexLeverageRouterAddress!,
          'quoteRedeemToCollateralExactIn',
          {
            isRedeem: true,
            collateralToken: collateralToken!,
            debtToken: debtToken!,
            multicallExecutor: market.seamlessPeriphery.multicallExecutor,
          },
        );
      }
    });

    it('6. Check Buy Redeem Prices (all configured markets)', async function () {
      for (const market of Object.values(marketConfig.marketsByLeverageToken)) {
        if (!(market.enableBuyRedeem ?? market.enableSellRedeem ?? false))
          continue;

        const collateralToken =
          tokensByAddress.get(
            market.seamlessLeverageToken.collateralToken.toLowerCase(),
          ) ?? null;
        const leverageToken =
          tokensByAddress.get(
            market.seamlessLeverageToken.leverageToken.toLowerCase(),
          ) ?? null;

        expect(collateralToken).not.toBeNull();
        expect(leverageToken).not.toBeNull();

        const unit = BI_POWS[collateralToken!.decimals];
        const buyAmounts = [
          0n,
          1n * unit,
          2n * unit,
          3n * unit,
          4n * unit,
          5n * unit,
          6n * unit,
          7n * unit,
          8n * unit,
          9n * unit,
          10n * unit,
        ];

        const leverageRouterAddress = market.seamlessPeriphery.leverageRouter;
        const dexLeverageRouterAddress =
          market.seamlessPeriphery.dexLeverageRouter;
        expect(leverageRouterAddress).toBeDefined();
        expect(dexLeverageRouterAddress).toBeDefined();

        await testPricingOnNetwork(
          seamlessProtocol,
          network,
          dexKey,
          blockNumber,
          leverageToken!,
          collateralToken!,
          SwapSide.BUY,
          buyAmounts,
          leverageToken!.address,
          leverageRouterAddress!,
          dexLeverageRouterAddress!,
          'quoteRedeemToCollateralExactOut',
          {
            isRedeem: true,
            collateralToken: collateralToken!,
            debtToken: debtToken!,
            multicallExecutor: market.seamlessPeriphery.multicallExecutor,
          },
        );
      }
    });

    it('2. Check Top Pools for Tokens (collateral token)', async function () {
      // We have to check without calling initializePricing, because
      // pool-tracker is not calling that function
      const newSeamlessProtocol = new SeamlessProtocol(
        network,
        dexKey,
        dexHelper,
      );
      if (newSeamlessProtocol.updatePoolState) {
        await newSeamlessProtocol.updatePoolState();
      }
      const poolLiquidity = await newSeamlessProtocol.getTopPoolsForToken(
        tokens[srcTokenSymbol].address,
        10,
      );

      console.log(`${srcTokenSymbol} Top Pools:`);
      console.dir(poolLiquidity, { depth: null });
      console.table(
        poolLiquidity.map(p => ({
          poolSymbol: getTokenSymbol(p.address),
          poolAddress: p.address,
          connectorSymbols: p.connectorTokens
            .map(t => getTokenSymbol(t.address))
            .join('\n'),
          connectorAddresses: p.connectorTokens.map(t => t.address).join('\n'),
          liquidityUSD: formatLiquidityUSD(p.liquidityUSD),
        })),
      );

      if (!newSeamlessProtocol.hasConstantPriceLargeAmounts) {
        checkPoolsLiquidity(
          poolLiquidity,
          Tokens[network][srcTokenSymbol].address,
          dexKey,
        );
      }
    });

    it('2. Check Top Pools for Tokens (leverage token)', async function () {
      const newSeamlessProtocol = new SeamlessProtocol(
        network,
        dexKey,
        dexHelper,
      );
      const poolLiquidity = await newSeamlessProtocol.getTopPoolsForToken(
        tokens[destTokenSymbol].address,
        10,
      );

      console.log(`${destTokenSymbol} Top Pools:`);
      console.dir(poolLiquidity, { depth: null });
      console.table(
        poolLiquidity.map(p => ({
          poolSymbol: getTokenSymbol(p.address),
          poolAddress: p.address,
          connectorSymbols: p.connectorTokens
            .map(t => getTokenSymbol(t.address))
            .join('\n'),
          connectorAddresses: p.connectorTokens.map(t => t.address).join('\n'),
          liquidityUSD: formatLiquidityUSD(p.liquidityUSD),
        })),
      );

      expect(poolLiquidity.length).toBeGreaterThan(0);
      // For an LT token, it should map to exactly one market/pool.
      expect(poolLiquidity.length).toBe(1);

      // Connector token should be the collateral (and should not equal the LT itself).
      poolLiquidity[0].connectorTokens.forEach(t => {
        expect(t.address.toLowerCase()).not.toBe(
          tokens[destTokenSymbol].address.toLowerCase(),
        );
      });
    });

    it('2. Check Top Pools for Tokens (no pools for token)', async function () {
      const newSeamlessProtocol = new SeamlessProtocol(
        network,
        dexKey,
        dexHelper,
      );

      // Use a token that is not a collateral or LT token for any Seamless market.
      const poolLiquidity = await newSeamlessProtocol.getTopPoolsForToken(
        tokens.WETH.address,
        10,
      );

      console.log(`WETH Top Pools (expected empty):`, poolLiquidity);
      expect(poolLiquidity).toEqual([]);
    });
  });
});
