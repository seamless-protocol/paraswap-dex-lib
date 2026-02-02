/* eslint-disable no-console */
import dotenv from 'dotenv';
dotenv.config();

import { Interface, Result } from '@ethersproject/abi';
import { DummyDexHelper } from '../../dex-helper/index';
import { Network, SwapSide } from '../../constants';
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
) {
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

    it('getPoolIdentifiers and getPricesVolume SELL (all configured markets)', async function () {
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

        await testPricingOnNetwork(
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
      }
    });

    it('getPoolIdentifiers and getPricesVolume BUY (Phase 1: unsupported)', async function () {
      const src = tokens[srcTokenSymbol];
      const dest = tokens[destTokenSymbol];

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

    it('getTopPoolsForToken (collateral token)', async function () {
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
      console.log(`${srcTokenSymbol} Top Pools:`, poolLiquidity);

      if (!newSeamlessProtocol.hasConstantPriceLargeAmounts) {
        checkPoolsLiquidity(
          poolLiquidity,
          Tokens[network][srcTokenSymbol].address,
          dexKey,
        );
      }
    });

    it('getTopPoolsForToken (leverage token)', async function () {
      const newSeamlessProtocol = new SeamlessProtocol(
        network,
        dexKey,
        dexHelper,
      );
      const poolLiquidity = await newSeamlessProtocol.getTopPoolsForToken(
        tokens[destTokenSymbol].address,
        10,
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

    it('getTopPoolsForToken (no pools for token)', async function () {
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
      expect(poolLiquidity).toEqual([]);
    });
  });
});
