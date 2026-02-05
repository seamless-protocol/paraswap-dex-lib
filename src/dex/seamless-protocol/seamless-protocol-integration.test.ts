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
import LEVERAGE_MANAGER_ABI from '../../abi/seamless-protocol/LeverageManager.json';
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

type ActionData = {
  collateral: bigint;
  debt: bigint;
  shares: bigint;
  tokenFee: bigint;
  treasuryFee: bigint;
};

const MAX_BRACKET_ITERATIONS = 64;
const MAX_BINARY_SEARCH_ITERATIONS = 128;
const MAX_UINT256 = (1n << 256n) - 1n;

const leverageRouterIface = new Interface(LEVERAGE_ROUTER_ABI);
const leverageManagerIface = new Interface(LEVERAGE_MANAGER_ABI);

const toBigInt = (value: unknown): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') return BigInt(value);
  if (value && typeof (value as any).toString === 'function') {
    return BigInt((value as any).toString());
  }
  return 0n;
};

const decodeActionData = (raw: any): ActionData => ({
  collateral: toBigInt(raw?.collateral ?? raw?.[0]),
  debt: toBigInt(raw?.debt ?? raw?.[1]),
  shares: toBigInt(raw?.shares ?? raw?.[2]),
  tokenFee: toBigInt(raw?.tokenFee ?? raw?.[3]),
  treasuryFee: toBigInt(raw?.treasuryFee ?? raw?.[4]),
});

const applyBpsCeil = (amount: bigint, bps: bigint): bigint => {
  if (amount === 0n || bps === 0n) return amount;
  return (amount * (BPS_SCALE + bps) + (BPS_SCALE - 1n)) / BPS_SCALE;
};
const applyBpsFloor = (amount: bigint, bps: bigint): bigint => {
  if (amount === 0n || bps === 0n) return amount;
  if (bps >= BPS_SCALE) return 0n;
  return (amount * (BPS_SCALE - bps)) / BPS_SCALE;
};

async function previewDepositAction(
  seamlessProtocol: SeamlessProtocol,
  leverageRouter: string,
  leverageToken: string,
  collateralFromSender: bigint,
  blockNumber: number,
): Promise<ActionData> {
  const callData = leverageRouterIface.encodeFunctionData('previewDeposit', [
    leverageToken,
    collateralFromSender.toString(),
  ]);
  const result = await seamlessProtocol.dexHelper.multiContract.methods
    .aggregate([{ target: leverageRouter, callData }])
    .call({}, blockNumber);
  const decoded = leverageRouterIface.decodeFunctionResult(
    'previewDeposit',
    result.returnData[0],
  );
  return decodeActionData(decoded[0]);
}

async function quoteMintExactOut(
  seamlessProtocol: SeamlessProtocol,
  leverageRouter: string,
  leverageToken: string,
  sharesOut: bigint,
  blockNumber: number,
): Promise<{
  collateralFromSender: bigint;
  action: ActionData;
  rawFlashLoanAmount: bigint;
  flashLoanAmount: bigint;
}> {
  if (sharesOut === 0n) {
    const zeroAction: ActionData = {
      collateral: 0n,
      debt: 0n,
      shares: 0n,
      tokenFee: 0n,
      treasuryFee: 0n,
    };
    return {
      collateralFromSender: 0n,
      action: zeroAction,
      rawFlashLoanAmount: 0n,
      flashLoanAmount: 0n,
    };
  }

  let low = 0n;
  let high = sharesOut;
  let action = await previewDepositAction(
    seamlessProtocol,
    leverageRouter,
    leverageToken,
    high,
    blockNumber,
  );

  for (let i = 0; action.shares < sharesOut; i++) {
    if (i >= MAX_BRACKET_ITERATIONS) {
      throw new Error(`quoteMintExactOut: bracket exceeded (${i})`);
    }
    low = high + 1n;
    if (high > MAX_UINT256 / 2n) {
      throw new Error(`quoteMintExactOut: overflow`);
    }
    high = high * 2n;
    action = await previewDepositAction(
      seamlessProtocol,
      leverageRouter,
      leverageToken,
      high,
      blockNumber,
    );
  }

  for (let i = 0; low < high; i++) {
    if (i >= MAX_BINARY_SEARCH_ITERATIONS) {
      throw new Error(`quoteMintExactOut: search exceeded (${i})`);
    }
    const mid = low + (high - low) / 2n;
    const midPreview = await previewDepositAction(
      seamlessProtocol,
      leverageRouter,
      leverageToken,
      mid,
      blockNumber,
    );
    if (midPreview.shares >= sharesOut) {
      high = mid;
      action = midPreview;
    } else {
      low = mid + 1n;
    }
  }

  const collateralFromSender = low;
  action = await previewDepositAction(
    seamlessProtocol,
    leverageRouter,
    leverageToken,
    collateralFromSender,
    blockNumber,
  );

  const rawFlashLoanAmount = action.debt;
  const flashLoanAmount = rawFlashLoanAmount;

  return {
    collateralFromSender,
    action,
    rawFlashLoanAmount,
    flashLoanAmount,
  };
}

async function batchPreviewActions(params: {
  seamlessProtocol: SeamlessProtocol;
  target: string;
  iface: Interface;
  funcName: 'previewDeposit' | 'previewRedeem' | 'previewWithdraw';
  leverageToken: string;
  amounts: bigint[];
  blockNumber: number;
}): Promise<ActionData[]> {
  const { seamlessProtocol, target, iface, funcName, leverageToken, amounts } =
    params;
  const actions: ActionData[] = new Array(amounts.length).fill({
    collateral: 0n,
    debt: 0n,
    shares: 0n,
    tokenFee: 0n,
    treasuryFee: 0n,
  });

  const calls: Array<{ target: string; callData: string }> = [];
  const indices: number[] = [];

  amounts.forEach((amount, idx) => {
    if (amount === 0n) return;
    indices.push(idx);
    calls.push({
      target,
      callData: iface.encodeFunctionData(funcName, [
        leverageToken,
        amount.toString(),
      ]),
    });
  });

  if (calls.length === 0) return actions;

  const result = await seamlessProtocol.dexHelper.multiContract.methods
    .aggregate(calls)
    .call({}, params.blockNumber);

  result.returnData.forEach((returnData: Result, i: number) => {
    const decoded = iface.decodeFunctionResult(funcName, returnData);
    actions[indices[i]] = decodeActionData(decoded[0]);
  });

  return actions;
}

const INTERNAL_SWAP_SLIPPAGE_BPS = '100';
const BPS_SCALE = 10_000n;
const INTERNAL_SWAP_BUFFER_BPS = (() => {
  const raw =
    process.env.SEAMLESS_INTERNAL_SWAP_BUFFER_BPS ?? INTERNAL_SWAP_SLIPPAGE_BPS;
  try {
    const parsed = BigInt(raw);
    return parsed < 0n ? 0n : parsed;
  } catch {
    return BigInt(INTERNAL_SWAP_SLIPPAGE_BPS);
  }
})();

async function checkOnChainPricing(
  seamlessProtocol: SeamlessProtocol,
  leverageRouterAddress: string,
  leverageManagerAddress: string,
  leverageToken: string,
  blockNumber: number,
  prices: bigint[],
  amounts: bigint[],
  quoteMode:
    | 'mintExactIn'
    | 'mintExactOut'
    | 'redeemExactIn'
    | 'redeemExactOut',
  opts?: {
    network?: Network;
    side?: SwapSide;
    collateralToken?: { address: string; decimals: number };
    debtToken?: { address: string; decimals: number };
    multicallExecutor?: string;
    isRedeem?: boolean;
  },
) {
  const expectedPrices: bigint[] = new Array(amounts.length).fill(0n);
  const flashLoans: bigint[] = new Array(amounts.length).fill(0n);

  if (quoteMode === 'mintExactIn') {
    const actions = await batchPreviewActions({
      seamlessProtocol,
      target: leverageRouterAddress,
      iface: leverageRouterIface,
      funcName: 'previewDeposit',
      leverageToken,
      amounts,
      blockNumber,
    });
    actions.forEach((action, idx) => {
      if (amounts[idx] === 0n) return;
      expectedPrices[idx] = action.shares;
      flashLoans[idx] = action.debt;
    });
  } else if (quoteMode === 'mintExactOut') {
    for (let i = 0; i < amounts.length; i++) {
      const sharesOut = amounts[i];
      if (sharesOut === 0n) continue;
      const quote = await quoteMintExactOut(
        seamlessProtocol,
        leverageRouterAddress,
        leverageToken,
        sharesOut,
        blockNumber,
      );
      expectedPrices[i] = quote.collateralFromSender;
      flashLoans[i] = quote.rawFlashLoanAmount;
    }
  } else if (quoteMode === 'redeemExactIn') {
    const actions = await batchPreviewActions({
      seamlessProtocol,
      target: leverageManagerAddress,
      iface: leverageManagerIface,
      funcName: 'previewRedeem',
      leverageToken,
      amounts,
      blockNumber,
    });
    actions.forEach((action, idx) => {
      if (amounts[idx] === 0n) return;
      expectedPrices[idx] = action.collateral;
      flashLoans[idx] = action.debt;
    });
  } else {
    const actions = await batchPreviewActions({
      seamlessProtocol,
      target: leverageManagerAddress,
      iface: leverageManagerIface,
      funcName: 'previewWithdraw',
      leverageToken,
      amounts,
      blockNumber,
    });
    actions.forEach((action, idx) => {
      if (amounts[idx] === 0n) return;
      expectedPrices[idx] = action.shares;
      flashLoans[idx] = action.debt;
    });
  }

  if (opts?.isRedeem && opts.side) {
    if (INTERNAL_SWAP_BUFFER_BPS > 0n) {
      for (let i = 0; i < amounts.length; i++) {
        if (amounts[i] === 0n) continue;
        if (opts.side === SwapSide.SELL) {
          expectedPrices[i] = applyBpsFloor(
            expectedPrices[i],
            INTERNAL_SWAP_BUFFER_BPS,
          );
        } else {
          expectedPrices[i] = applyBpsCeil(
            expectedPrices[i],
            INTERNAL_SWAP_BUFFER_BPS,
          );
          flashLoans[i] = applyBpsCeil(flashLoans[i], INTERNAL_SWAP_BUFFER_BPS);
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
  leverageManagerAddress: string,
  quoteMode:
    | 'mintExactIn'
    | 'mintExactOut'
    | 'redeemExactIn'
    | 'redeemExactOut',
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
    leverageRouterAddress,
    leverageManagerAddress,
    leverageTokenAddress,
    blockNumber,
    poolPrices![0].prices,
    amounts,
    quoteMode,
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
        const leverageManagerAddress = market.seamlessCore.leverageManager;
        expect(leverageRouterAddress).toBeDefined();
        expect(leverageManagerAddress).toBeDefined();

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
          leverageManagerAddress!,
          'mintExactIn',
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
        const leverageManagerAddress = market.seamlessCore.leverageManager;
        expect(leverageRouterAddress).toBeDefined();
        expect(leverageManagerAddress).toBeDefined();

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
          leverageManagerAddress!,
          'mintExactOut',
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
        const leverageManagerAddress = market.seamlessCore.leverageManager;
        expect(leverageRouterAddress).toBeDefined();
        expect(leverageManagerAddress).toBeDefined();

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
          leverageManagerAddress!,
          'redeemExactIn',
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
        const debtToken =
          tokensByAddress.get(
            market.seamlessLeverageToken.debtToken.toLowerCase(),
          ) ?? null;

        expect(collateralToken).not.toBeNull();
        expect(leverageToken).not.toBeNull();
        expect(debtToken).not.toBeNull();

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
        const leverageManagerAddress = market.seamlessCore.leverageManager;
        expect(leverageRouterAddress).toBeDefined();
        expect(leverageManagerAddress).toBeDefined();

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
          leverageManagerAddress!,
          'redeemExactOut',
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
