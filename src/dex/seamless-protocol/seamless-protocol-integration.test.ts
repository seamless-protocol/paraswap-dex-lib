/* eslint-disable no-console */
import dotenv from 'dotenv';
dotenv.config();

import { Interface, Result } from '@ethersproject/abi';
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
import LEVERAGE_ROUTER_ABI from '../../abi/seamless-protocol/LeverageRouter.json';
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

function getReaderCalldata(
  exchangeAddress: string,
  readerIface: Interface,
  leverageToken: string,
  amounts: bigint[],
  funcName: string,
) {
  return amounts.map(amount => ({
    target: exchangeAddress,
    callData: readerIface.encodeFunctionData(funcName, [
      leverageToken,
      amount.toString(),
    ]),
  }));
}

function decodeReaderResult(results: Result, readerIface: Interface) {
  return results.map(result => {
    const parsed = readerIface.decodeFunctionResult('previewDeposit', result);
    const preview = parsed[0];
    return BigInt(preview.shares.toString());
  });
}

async function checkOnChainPricing(
  seamlessProtocol: SeamlessProtocol,
  leverageRouterAddress: string,
  leverageToken: string,
  blockNumber: number,
  prices: bigint[],
  amounts: bigint[],
) {
  const readerIface = new Interface(LEVERAGE_ROUTER_ABI);
  const readerCallData = getReaderCalldata(
    leverageRouterAddress,
    readerIface,
    leverageToken,
    amounts.slice(1),
    'previewDeposit',
  );
  const readerResult = (
    await seamlessProtocol.dexHelper.multiContract.methods
      .aggregate(readerCallData)
      .call({}, blockNumber)
  ).returnData;

  const expectedPrices = [0n].concat(
    decodeReaderResult(readerResult, readerIface),
  );

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
  leverageRouterAddress: string,
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
    leverageRouterAddress,
    destToken.address,
    blockNumber,
    poolPrices![0].prices,
    amounts,
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
        expect(leverageRouterAddress).toBeDefined();

        const pricingSummary = await testPricingOnNetwork(
          seamlessProtocol,
          network,
          dexKey,
          blockNumber,
          collateralToken!,
          leverageToken!,
          SwapSide.SELL,
          sellAmounts,
          leverageRouterAddress!,
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

    it('4. Check Buy Prices (Phase 1: unsupported)', async function () {
      const src = tokens[srcTokenSymbol];
      const dest = tokens[destTokenSymbol];

      console.log(
        `Phase 1: BUY unsupported. Verifying getPoolIdentifiers=[] and getPricesVolume=null for ${srcTokenSymbol} -> ${destTokenSymbol} at block ${blockNumber}`,
      );

      const pools = await seamlessProtocol.getPoolIdentifiers(
        src,
        dest,
        SwapSide.BUY,
        blockNumber,
      );
      expect(pools).toEqual([]);

      const poolPrices = await seamlessProtocol.getPricesVolume(
        src,
        dest,
        amountsForBuy,
        SwapSide.BUY,
        blockNumber,
      );
      expect(poolPrices).toBeNull();
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
