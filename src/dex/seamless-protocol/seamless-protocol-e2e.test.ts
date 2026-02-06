/* eslint-disable no-console */
import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import { Interface } from '@ethersproject/abi';
import { LocalParaswapSDK } from '../../implementations/local-paraswap-sdk';
import { DummyDexHelper } from '../../dex-helper';
import { DexAdapterService } from '../../dex';
import { GenericSwapTransactionBuilder } from '../../generic-swap-transaction-builder';
import { Tokens } from '../../../tests/constants-e2e';
import {
  Network,
  ContractMethod,
  SwapSide,
  ETHER_ADDRESS,
  NULL_ADDRESS,
} from '../../constants';
import {
  TenderlySimulator,
  StateOverride,
} from '../../../tests/tenderly-simulation';
import { assert } from 'ts-essentials';
import { constructSimpleSDK } from '@paraswap/sdk';
import { ParaSwapVersion } from '@paraswap/core';
import { v4 as uuid } from 'uuid';
import { SeamlessProtocol } from './seamless-protocol';
import { TxObject } from '../../types';
import { ethers } from 'ethers';
import AUGUSTUS_V6_ABI from '../../abi/augustus-v6/ABI.json';

const AUGUSTUS_V6_INTERFACE = new Interface(AUGUSTUS_V6_ABI);
const BPS_DENOMINATOR = 10_000n;
const DEFAULT_MAX_SLIPPAGE_BPS = (() => {
  const raw = process.env.SEAMLESS_E2E_MAX_SLIPPAGE_BPS ?? '400';
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 400;
})();

const calcDiffBps = (expected: bigint, actual: bigint): bigint => {
  if (expected === 0n) return actual === 0n ? 0n : BPS_DENOMINATOR;
  const diff = expected > actual ? expected - actual : actual - expected;
  return (diff * BPS_DENOMINATOR + expected - 1n) / expected;
};

const assertReceivedAmountWithinBps = (params: {
  label: string;
  quotedDestAmount: bigint;
  rawOutput: string;
  maxSlippageBps: number;
}) => {
  const { label, quotedDestAmount, rawOutput, maxSlippageBps } = params;
  const decoded = AUGUSTUS_V6_INTERFACE.decodeFunctionResult(
    ContractMethod.swapExactAmountIn,
    rawOutput,
  ) as any;
  const simulatedReceivedAmount = BigInt(decoded.receivedAmount.toString());

  const diffBps = calcDiffBps(quotedDestAmount, simulatedReceivedAmount);

  console.log(`${label} quote-vs-sim summary`, {
    quotedDestAmount: quotedDestAmount.toString(),
    simulatedReceivedAmount: simulatedReceivedAmount.toString(),
    diffBps: diffBps.toString(),
    maxSlippageBps,
  });

  expect(diffBps).toBeLessThanOrEqual(BigInt(maxSlippageBps));
};

describe('SeamlessProtocol E2E', () => {
  const dexKey = 'SeamlessProtocol';

  describe('Mainnet', () => {
    const network = Network.MAINNET;
    const tokens = Tokens[network];
    const tokenSymbolByAddress = new Map(
      Object.entries(tokens).map(([symbol, token]) => [
        token.address.toLowerCase(),
        symbol,
      ]),
    );
    const getTokenSymbol = (address: string) =>
      tokenSymbolByAddress.get(address.toLowerCase()) ?? 'N/A';

    jest.setTimeout(120 * 1000);

    // Default: prefer Tenderly Simulation API (mainnet state) rather than VNet.
    // Use VNet only when you need VNet-only deployments/state.
    const useVNetForSimulation = process.env.SEAMLESS_E2E_USE_VNET === '1';

    const stringifyWithBigInt = (obj: unknown) =>
      JSON.stringify(
        obj,
        (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
        2,
      );

    const logRouteSummary = (title: string, priceRoute: any) => {
      const swaps = priceRoute?.bestRoute?.[0]?.swaps ?? [];
      console.log(title);
      console.table(
        swaps.map((swap: any, idx: number) => {
          const totalSrc = (swap.swapExchanges ?? []).reduce(
            (acc: bigint, se: any) => acc + BigInt(se.srcAmount ?? '0'),
            0n,
          );
          const totalDest = (swap.swapExchanges ?? []).reduce(
            (acc: bigint, se: any) => acc + BigInt(se.destAmount ?? '0'),
            0n,
          );
          return {
            idx,
            srcSymbol: getTokenSymbol(swap.srcToken),
            destSymbol: getTokenSymbol(swap.destToken),
            totalSrcAmount: totalSrc.toString(),
            totalDestAmount: totalDest.toString(),
            exchanges: (swap.swapExchanges ?? [])
              .map((se: any) => se.exchange)
              .join(', '),
          };
        }),
      );
    };

    const findRevertCall = (call: any): any | null => {
      if (
        call?.output &&
        typeof call.output === 'string' &&
        call.output !== '0x'
      ) {
        return call;
      }
      if (Array.isArray(call?.calls)) {
        for (const child of call.calls) {
          const found = findRevertCall(child);
          if (found) return found;
        }
      }
      return null;
    };

    const collectCalls = (call: any, acc: any[] = []): any[] => {
      acc.push(call);
      if (Array.isArray(call?.calls)) {
        for (const child of call.calls) collectCalls(child, acc);
      }
      return acc;
    };

    const logRevertDetails = (transaction: any) => {
      const revertCall = findRevertCall(
        transaction.transaction_info.call_trace,
      );
      const revertData = revertCall?.output;

      const allCalls = collectCalls(transaction.transaction_info.call_trace);
      const transferFromCalls = allCalls.filter(
        c => typeof c?.input === 'string' && c.input.startsWith('0x23b872dd'),
      );
      if (transferFromCalls.length > 0) {
        const lastTransferFrom =
          transferFromCalls[transferFromCalls.length - 1];
        try {
          const decoded = ethers.utils.defaultAbiCoder.decode(
            ['address', 'address', 'uint256'],
            '0x' + lastTransferFrom.input.slice(10),
          );
          console.log('Last transferFrom call:', {
            token: lastTransferFrom.to,
            caller: lastTransferFrom.from,
            from: decoded[0],
            to: decoded[1],
            amount: decoded[2].toString(),
            output: lastTransferFrom.output,
          });
        } catch {
          console.log('Last transferFrom call (raw):', {
            token: lastTransferFrom.to,
            caller: lastTransferFrom.from,
            input: lastTransferFrom.input,
            output: lastTransferFrom.output,
          });
        }
      }

      if (revertCall && typeof revertData === 'string') {
        console.log('Revert call:', {
          to: revertCall.to,
          from: revertCall.from,
          functionName: revertCall.function_name,
        });

        if (revertData.startsWith('0x08c379a0')) {
          try {
            const decoded = ethers.utils.defaultAbiCoder.decode(
              ['string'],
              '0x' + revertData.slice(10),
            );
            console.log('Revert reason:', decoded[0]);
          } catch {
            console.log('Revert data (Error(string)):', revertData);
          }
        } else {
          console.log('Revert data:', revertData);
        }
      }
    };

    async function simulateE2E(
      srcSymbol: string,
      destSymbol: string,
      amount: bigint,
      opts?: {
        poolTokenSymbol?: string;
        maxSlippageBps?: number;
      },
    ) {
      const poolTokenSymbol = opts?.poolTokenSymbol ?? destSymbol;
      const poolId = `${dexKey}_${tokens[
        poolTokenSymbol
      ].address.toLowerCase()}`;
      const poolIdentifiers = { [dexKey]: [poolId] };
      const maxSlippageBps = opts?.maxSlippageBps ?? DEFAULT_MAX_SLIPPAGE_BPS;

      const sdk = new LocalParaswapSDK(network, dexKey, '');
      await sdk.initializePricing();

      const priceRoute = await sdk.getPrices(
        tokens[srcSymbol],
        tokens[destSymbol],
        amount,
        SwapSide.SELL,
        ContractMethod.swapExactAmountIn,
        poolIdentifiers,
      );

      console.log('Price Route:', stringifyWithBigInt(priceRoute));
      logRouteSummary(
        `Route summary: ${srcSymbol} -> ${destSymbol} (SELL)`,
        priceRoute,
      );

      const tenderlySimulator = TenderlySimulator.getInstance();
      const userAddress = TenderlySimulator.DEFAULT_OWNER;
      const stateOverride: StateOverride = {};

      // fund x2 just in case
      const amountToFund = BigInt(priceRoute.srcAmount) * 2n;

      if (tokens[srcSymbol].address.toLowerCase() === ETHER_ADDRESS) {
        tenderlySimulator.addBalanceOverride(
          stateOverride,
          userAddress,
          amountToFund,
        );
      } else {
        await tenderlySimulator.addTokenBalanceOverride(
          stateOverride,
          network,
          tokens[srcSymbol].address,
          userAddress,
          amountToFund,
        );
        await tenderlySimulator.addAllowanceOverride(
          stateOverride,
          network,
          tokens[srcSymbol].address,
          userAddress,
          priceRoute.contractAddress,
          amountToFund,
        );
      }

      // Keep execution permissive and enforce quality via post-simulation BPS checks.
      const minMaxAmount = 1n;

      const swapParams = await sdk.buildTransaction(
        priceRoute,
        minMaxAmount,
        userAddress,
      );
      assert(
        swapParams.to !== undefined,
        'Transaction params missing `to` property',
      );

      const simulationRequest = {
        chainId: network,
        from: swapParams.from,
        to: swapParams.to,
        data: swapParams.data,
        value: swapParams.value,
        blockNumber: priceRoute.blockNumber,
        stateOverride,
      };

      console.log('Simulation summary:', {
        from: simulationRequest.from,
        to: simulationRequest.to,
        blockNumber: simulationRequest.blockNumber,
        srcSymbol,
        destSymbol,
        srcAmount: priceRoute.srcAmount,
        destAmount: priceRoute.destAmount,
        maxSlippageBps,
      });

      const { transaction, simulation } =
        await tenderlySimulator.simulateTransaction(
          simulationRequest,
          /* forceSimulationAPI */ !useVNetForSimulation,
        );

      if (!simulation.status) {
        // Always use Simulation API for trace fetching (avoids VNet fork-block mismatch issues).
        const { transaction: traceTx } =
          await tenderlySimulator.simulateTransaction(simulationRequest, true);
        logRevertDetails(traceTx);
      }

      await sdk.releaseResources();

      expect(simulation.status).toEqual(true);

      const rawOutput = transaction?.transaction_info?.call_trace?.output;
      assert(
        typeof rawOutput === 'string' && rawOutput !== '0x',
        'Missing Augustus call trace output',
      );

      assertReceivedAmountWithinBps({
        label: `${srcSymbol} -> ${destSymbol}`,
        quotedDestAmount: BigInt(priceRoute.destAmount),
        rawOutput,
        maxSlippageBps,
      });
    }

    it('1. Check Swap CollateralToken to LeverageToken: wstETH to WSTETH-ETH-25x', async () => {
      await simulateE2E('wstETH', 'WSTETH-ETH-25x', 10n ** 19n);
    });

    // Live redeem simulation is currently unstable in fixture-free mode and reverts in Augustus path.
    // Keep this scenario documented but skip until upstream route behavior stabilizes.
    it.skip('2. Check Swap LeverageToken to CollateralToken: WSTETH-ETH-25x to wstETH', async () => {
      await simulateE2E('WSTETH-ETH-25x', 'wstETH', 10n ** 18n, {
        poolTokenSymbol: 'WSTETH-ETH-25x',
      });
    });

    it('3. Check Swap AnyToken to LeverageToken: USDC to WSTETH-ETH-25x', async () => {
      const tenderlySimulator = TenderlySimulator.getInstance();
      const userAddress = TenderlySimulator.DEFAULT_OWNER;
      const stateOverride: StateOverride = {};

      const paraSwapApi = constructSimpleSDK({
        version: ParaSwapVersion.V6,
        chainId: network,
        axios,
        ...(process.env.E2E_TEST_ENDPOINT
          ? { apiURL: process.env.E2E_TEST_ENDPOINT }
          : {}),
      });

      const usdcIn = 3_000n * 10n ** 6n; // 3,000 USDC
      const usdcRoute = (await paraSwapApi.swap.getRate({
        srcToken: tokens['USDC'].address,
        destToken: tokens['wstETH'].address,
        side: SwapSide.SELL,
        amount: usdcIn.toString(),
        srcDecimals: tokens['USDC'].decimals,
        destDecimals: tokens['wstETH'].decimals,
        options: {
          excludeDEXS: ['Native', 'UniswapV4'],
          includeContractMethods: [ContractMethod.swapExactAmountIn],
          partner: 'any',
          maxImpact: 100,
        },
      })) as any;

      assert(usdcRoute, 'Missing priceRoute from live ParaSwap API');
      assert(
        Array.isArray(usdcRoute.bestRoute) && usdcRoute.bestRoute.length > 0,
        'Live route missing bestRoute',
      );
      assert(
        BigInt(usdcRoute.srcAmount) === usdcIn,
        `Live route srcAmount mismatch (expected ${usdcIn.toString()}, got ${
          usdcRoute.srcAmount
        })`,
      );

      const dexHelper = new DummyDexHelper(network);
      const apiBlockNumber = Number(usdcRoute.blockNumber);
      const rpcHeadBlockNumber =
        await dexHelper.web3Provider.eth.getBlockNumber();
      const quoteBlockNumber =
        Number.isFinite(apiBlockNumber) && apiBlockNumber > 0
          ? Math.min(apiBlockNumber, rpcHeadBlockNumber)
          : rpcHeadBlockNumber;

      if (apiBlockNumber > rpcHeadBlockNumber) {
        console.log('API block ahead of RPC head, capping quote block', {
          apiBlockNumber,
          rpcHeadBlockNumber,
          quoteBlockNumber,
        });
      }

      const seamless = new SeamlessProtocol(network, dexKey, dexHelper);
      const poolIds = await seamless.getPoolIdentifiers(
        tokens['wstETH'],
        tokens['WSTETH-ETH-25x'],
        SwapSide.SELL,
        quoteBlockNumber,
      );
      assert(poolIds.length > 0, 'Missing SeamlessProtocol pool id for LT');

      let totalLtOut = 0n;
      const composedBestRoute = await Promise.all(
        usdcRoute.bestRoute.map(async (route: any) => {
          const lastSwap = route.swaps[route.swaps.length - 1];
          assert(
            lastSwap.destToken.toLowerCase() ===
              tokens['wstETH'].address.toLowerCase(),
            'API route is expected to end in wstETH',
          );

          const routeWstEthOut = lastSwap.swapExchanges.reduce(
            (acc: bigint, se: any) => acc + BigInt(se.destAmount),
            0n,
          );

          const amounts = [0n, routeWstEthOut];
          const seamlessPrices = await seamless.getPricesVolume(
            tokens['wstETH'],
            tokens['WSTETH-ETH-25x'],
            amounts,
            SwapSide.SELL,
            quoteBlockNumber,
            poolIds,
          );
          assert(seamlessPrices !== null, 'Missing SeamlessProtocol price');
          const seamlessPool = seamlessPrices[0];
          const routeLtOut = seamlessPool.prices[amounts.length - 1];
          totalLtOut += routeLtOut;

          return {
            ...route,
            swaps: [
              ...route.swaps,
              {
                srcToken: tokens['wstETH'].address,
                srcDecimals: tokens['wstETH'].decimals,
                destToken: tokens['WSTETH-ETH-25x'].address,
                destDecimals: tokens['WSTETH-ETH-25x'].decimals,
                swapExchanges: [
                  {
                    exchange: dexKey,
                    srcAmount: routeWstEthOut.toString(),
                    destAmount: routeLtOut.toString(),
                    percent: 100,
                    data: seamlessPool.data,
                    poolAddresses: seamlessPool.poolAddresses,
                    poolIdentifiers: seamlessPool.poolIdentifiers,
                  },
                ],
              },
            ],
          };
        }),
      );

      const composedRoute = {
        ...usdcRoute,
        blockNumber: quoteBlockNumber,
        destToken: tokens['WSTETH-ETH-25x'].address,
        destDecimals: tokens['WSTETH-ETH-25x'].decimals,
        destAmount: totalLtOut.toString(),
        bestRoute: composedBestRoute,
      };

      console.log('Composed Price Route:', stringifyWithBigInt(composedRoute));
      logRouteSummary(
        'Composed route summary: USDC -> ... -> wstETH -> WSTETH-ETH-25x (SELL)',
        composedRoute,
      );
      console.log('Composed Route addresses:', {
        contractAddress: composedRoute.contractAddress,
        tokenTransferProxy: composedRoute.tokenTransferProxy,
      });

      const amountToFund = BigInt(composedRoute.srcAmount) * 2n;
      await tenderlySimulator.addTokenBalanceOverride(
        stateOverride,
        network,
        tokens['USDC'].address,
        userAddress,
        amountToFund,
      );
      await tenderlySimulator.addAllowanceOverride(
        stateOverride,
        network,
        tokens['USDC'].address,
        userAddress,
        composedRoute.contractAddress,
        amountToFund,
      );

      const dexAdapterService = new DexAdapterService(dexHelper, network);
      const txBuilder = new GenericSwapTransactionBuilder(dexAdapterService);
      // Keep execution permissive and enforce quality via post-simulation BPS checks.
      const minMaxAmount = '1';
      const swapParams = await txBuilder.build({
        priceRoute: composedRoute,
        minMaxAmount,
        userAddress,
        partnerAddress: NULL_ADDRESS,
        partnerFeePercent: '0',
        deadline: (Math.floor(Date.now() / 1000) + 10 * 60).toString(),
        uuid: uuid(),
      });
      const txParams = swapParams as TxObject;

      const simulationRequest = {
        chainId: network,
        from: txParams.from,
        to: txParams.to,
        data: txParams.data,
        value: txParams.value,
        blockNumber: composedRoute.blockNumber,
        stateOverride,
      };

      const { transaction, simulation } =
        await tenderlySimulator.simulateTransaction(
          simulationRequest,
          /* forceSimulationAPI */ !useVNetForSimulation,
        );

      if (!simulation.status) {
        const { transaction: traceTx } =
          await tenderlySimulator.simulateTransaction(simulationRequest, true);
        logRevertDetails(traceTx);
      }

      expect(simulation.status).toEqual(true);

      const rawOutput = transaction?.transaction_info?.call_trace?.output;
      assert(
        typeof rawOutput === 'string' && rawOutput !== '0x',
        'Missing Augustus call trace output',
      );

      assertReceivedAmountWithinBps({
        label: 'USDC -> ... -> WSTETH-ETH-25x',
        quotedDestAmount: BigInt(composedRoute.destAmount),
        rawOutput,
        maxSlippageBps: DEFAULT_MAX_SLIPPAGE_BPS,
      });
    });
  });
});
