/* eslint-disable no-console */
import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
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
import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';

describe('SeamlessProtocol E2E', () => {
  const dexKey = 'SeamlessProtocol';
  const LEVERAGE_ROUTER_RECIPIENT_WRAPPER =
    '0x1111111111111111111111111111111111111111';

  describe('Mainnet', () => {
    const network = Network.MAINNET;
    const tokens = Tokens[network];

    jest.setTimeout(120 * 1000);

    const stringifyWithBigInt = (obj: unknown) =>
      JSON.stringify(
        obj,
        (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
        2,
      );

    const getLeverageRouterRecipientWrapperRuntimeBytecode = (): string => {
      // Loaded from the Foundry artifact in leverage-tokens. This keeps the DexLib side self-contained while we
      // iterate on the wrapper contract.
      const artifactPath = path.resolve(
        __dirname,
        '../../../../leverage-tokens/out/LeverageRouterRecipientWrapper.sol/LeverageRouterRecipientWrapper.json',
      );
      const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
        deployedBytecode?: { object?: string };
      };
      const runtimeBytecode = artifact.deployedBytecode?.object;
      assert(
        typeof runtimeBytecode === 'string' && runtimeBytecode.startsWith('0x'),
        `Missing deployedBytecode.object in ${artifactPath}`,
      );
      return runtimeBytecode;
    };

    async function simulateE2E(
      srcSymbol: string,
      destSymbol: string,
      amount: bigint,
    ) {
      const poolId = `${dexKey}_${tokens[destSymbol].address.toLowerCase()}`;
      const poolIdentifiers = { [dexKey]: [poolId] };

      // Force LocalParaswapSDK (no ParaSwap public API) and pin execution to the local SeamlessProtocol module.
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

      const tenderlySimulator = TenderlySimulator.getInstance();
      const userAddress = TenderlySimulator.DEFAULT_OWNER;
      const stateOverride: StateOverride = {};

      // Inject the Gate 1 venue wrapper code so the SeamlessProtocol leg can honor recipient semantics and return
      // `sharesOut` for returnAmountPos.
      stateOverride[LEVERAGE_ROUTER_RECIPIENT_WRAPPER.toLowerCase()] = {
        code: getLeverageRouterRecipientWrapperRuntimeBytecode(),
      };

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

      // Keep minAmountOut permissive for Phase 1: we are validating wiring + recipient semantics, not quote accuracy
      // vs internal swap slippage.
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

      const { simulation } = await tenderlySimulator.simulateTransaction(
        simulationRequest,
      );

      await sdk.releaseResources();

      expect(simulation.status).toEqual(true);
    }

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

    it('wstETH -> WSTETH-ETH-25x (Gate 1 wrapper)', async () => {
      await simulateE2E('wstETH', 'WSTETH-ETH-25x', 10n ** 19n);
    });

    it('USDC -> wstETH -> WSTETH-ETH-25x (Gate 1 wrapper)', async () => {
      const tenderlySimulator = TenderlySimulator.getInstance();
      const userAddress = TenderlySimulator.DEFAULT_OWNER;
      const stateOverride: StateOverride = {};

      stateOverride[LEVERAGE_ROUTER_RECIPIENT_WRAPPER.toLowerCase()] = {
        code: getLeverageRouterRecipientWrapperRuntimeBytecode(),
      };

      // 1) Get USDC -> wstETH via ParaSwap API (Velora routing engine) for realism.
      //    NOTE: API `blockNumber` can be ahead of our RPC head (e.g. when using a fixed/block-pinned fork RPC),
      //    so we pin all onchain reads + the simulation to the RPC head block.
      const apiURL = process.env.E2E_TEST_ENDPOINT ?? 'https://api.paraswap.io';
      const paraSwap = constructSimpleSDK({
        version: ParaSwapVersion.V6,
        chainId: network,
        axios,
        apiURL,
      });

      const dexHelper = new DummyDexHelper(network);
      const pinnedBlockNumber =
        await dexHelper.web3Provider.eth.getBlockNumber();

      const usdcIn = 3_000n * 10n ** 6n; // 3,000 USDC
      const usdcRoute = (await paraSwap.swap.getRate({
        srcToken: tokens['USDC'].address,
        destToken: tokens['wstETH'].address,
        side: SwapSide.SELL,
        amount: usdcIn.toString(),
        options: {
          // Avoid RFQ/native legs that require preProcessTransaction (txRequest) which this test does not run.
          // Also avoid UniswapV4 paths in this E2E: V4 legs can introduce permit2/wrapping complexity that is not the
          // focus of the Seamless venue integration.
          excludeDEXS: ['Native', 'UniswapV4'],
          includeContractMethods: [ContractMethod.swapExactAmountIn],
          partner: 'any',
          maxImpact: 100,
        },
        srcDecimals: tokens['USDC'].decimals,
        destDecimals: tokens['wstETH'].decimals,
      })) as any;

      // 2) Quote wstETH -> LT (SeamlessProtocol) at the pinned blockNumber so flashLoanAmount is consistent.
      const seamless = new SeamlessProtocol(network, dexKey, dexHelper);
      const poolIds = await seamless.getPoolIdentifiers(
        tokens['wstETH'],
        tokens['WSTETH-ETH-25x'],
        SwapSide.SELL,
        pinnedBlockNumber,
      );
      assert(poolIds.length > 0, 'Missing SeamlessProtocol pool id for LT');

      // 3) Compose a synthetic multi-leg ParaSwap route:
      //    USDC -> wstETH (API) then wstETH -> LT (local SeamlessProtocol) appended to each bestRoute path.
      //    NOTE: The ParaSwap V6 executor will treat the API swaps as intermediate legs (recipient=executor) and the
      //    Seamless leg as the last leg (recipient=augustus). Without the wrapper venue target, this would strand
      //    minted shares on the executor and revert in simulation.
      assert(
        Array.isArray(usdcRoute.bestRoute) && usdcRoute.bestRoute.length > 0,
        'API route missing bestRoute',
      );

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
            pinnedBlockNumber,
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
        blockNumber: pinnedBlockNumber,
        destToken: tokens['WSTETH-ETH-25x'].address,
        destDecimals: tokens['WSTETH-ETH-25x'].decimals,
        destAmount: totalLtOut.toString(),
        bestRoute: composedBestRoute,
      };

      console.log('Composed Price Route:', stringifyWithBigInt(composedRoute));
      console.log('Composed Route addresses:', {
        contractAddress: composedRoute.contractAddress,
        tokenTransferProxy: composedRoute.tokenTransferProxy,
      });

      // Fund + approve user USDC to Augustus (standard V6 path).
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

      // Build transaction locally (DexLib tx builder).
      const dexAdapterService = new DexAdapterService(dexHelper, network);
      const txBuilder = new GenericSwapTransactionBuilder(dexAdapterService);
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

      const { simulation } = await tenderlySimulator.simulateTransaction(
        simulationRequest,
      );

      if (!simulation.status) {
        const { transaction } = await tenderlySimulator.simulateTransaction(
          simulationRequest,
          true,
        );
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
      }

      expect(simulation.status).toEqual(true);
    });
  });
});
