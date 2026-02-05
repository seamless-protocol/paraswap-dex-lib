/* eslint-disable no-console */
import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
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

    const fixturesPath =
      process.env.SEAMLESS_VELORA_SWAP_FIXTURES_PATH ??
      path.resolve(
        process.cwd(),
        'tests/fixtures/seamless-protocol/velora-swap.json',
      );

    const paraswapRateFixturePath =
      process.env.SEAMLESS_PARASWAP_RATE_FIXTURE_PATH ??
      path.resolve(
        process.cwd(),
        'tests/fixtures/seamless-protocol/paraswap-rate-usdc-wsteth.json',
      );

    // This block is used to keep Seamless previewDeposit and the frozen Velora /swap fixture in sync.
    // If you update the fixture, update this block too.
    const pinnedBlockNumber = Number(
      process.env.SEAMLESS_E2E_PINNED_BLOCK_NUMBER ?? '24387094',
    );

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

    async function simulateE2E(
      srcSymbol: string,
      destSymbol: string,
      amount: bigint,
      opts?: {
        pinBlockNumber?: number;
        strictVeloraFixtures?: boolean;
        poolTokenSymbol?: string;
      },
    ) {
      const poolTokenSymbol = opts?.poolTokenSymbol ?? destSymbol;
      const poolId = `${dexKey}_${tokens[
        poolTokenSymbol
      ].address.toLowerCase()}`;
      const poolIdentifiers = { [dexKey]: [poolId] };

      // Force LocalParaswapSDK (no ParaSwap public API) and pin execution to the local SeamlessProtocol module.
      process.env.SEAMLESS_VELORA_SWAP_FIXTURES_PATH = fixturesPath;
      const strictVeloraFixtures =
        opts?.strictVeloraFixtures ?? Boolean(process.env.CI);
      process.env.SEAMLESS_VELORA_SWAP_FIXTURES_STRICT = strictVeloraFixtures
        ? '1'
        : '0';

      const sdk = new LocalParaswapSDK(network, dexKey, '');
      const blockToPin = opts?.pinBlockNumber;
      if (blockToPin !== undefined) {
        // LocalParaswapSDK internally calls both web3 and ethers providers for block number.
        // Patch both so quote + simulation use a consistent pinned block.
        (sdk.dexHelper.provider as any).getBlockNumber = async () => blockToPin;
        (sdk.dexHelper.web3Provider.eth as any).getBlockNumber = async () =>
          blockToPin;
      }
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

      // Keep minAmountOut permissive: we are validating wiring + recipient semantics, not quote accuracy
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

      console.log('Simulation summary:', {
        from: simulationRequest.from,
        to: simulationRequest.to,
        blockNumber: simulationRequest.blockNumber,
        srcSymbol,
        destSymbol,
        srcAmount: priceRoute.srcAmount,
        destAmount: priceRoute.destAmount,
      });

      const { simulation } = await tenderlySimulator.simulateTransaction(
        simulationRequest,
        /* forceSimulationAPI */ !useVNetForSimulation,
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

    it('1. Check Swap CollateralToken to LeverageToken: wstETH to WSTETH-ETH-25x', async () => {
      await simulateE2E('wstETH', 'WSTETH-ETH-25x', 10n ** 19n, {
        pinBlockNumber: pinnedBlockNumber,
        strictVeloraFixtures: Boolean(process.env.CI),
      });
    });

    it('2. Check Swap LeverageToken to CollateralToken: WSTETH-ETH-25x to wstETH', async () => {
      await simulateE2E('WSTETH-ETH-25x', 'wstETH', 10n ** 18n, {
        pinBlockNumber: pinnedBlockNumber,
        strictVeloraFixtures: Boolean(process.env.CI),
        poolTokenSymbol: 'WSTETH-ETH-25x',
      });
    });

    it('3. Check Swap AnyToken to LeverageToken: USDC to WSTETH-ETH-25x', async () => {
      // Deterministic path:
      // - USDC->wstETH leg is frozen via a ParaSwap /prices fixture (no live API call)
      // - internal leverage swap (/swap, debtAsset->collateral) is frozen via Velora /swap fixtures
      process.env.SEAMLESS_VELORA_SWAP_FIXTURES_PATH = fixturesPath;
      process.env.SEAMLESS_VELORA_SWAP_FIXTURES_STRICT = Boolean(process.env.CI)
        ? '1'
        : '0';

      const tenderlySimulator = TenderlySimulator.getInstance();
      const userAddress = TenderlySimulator.DEFAULT_OWNER;
      const stateOverride: StateOverride = {};

      // 1) Load a frozen ParaSwap /prices (getRate) fixture for USDC -> wstETH.
      //    This keeps the intermediate wstETH output (and therefore the Seamless flashLoanAmount) deterministic.
      const fixture = JSON.parse(
        fs.readFileSync(paraswapRateFixturePath, 'utf8'),
      );
      const usdcRoute = fixture?.priceRoute;
      assert(usdcRoute, 'Missing priceRoute in ParaSwap rate fixture');
      assert(
        Array.isArray(usdcRoute.bestRoute) && usdcRoute.bestRoute.length > 0,
        'Fixture route missing bestRoute',
      );

      const pinnedBlockNumber = Number(usdcRoute.blockNumber);
      assert(
        Number.isFinite(pinnedBlockNumber) && pinnedBlockNumber > 0,
        `Invalid pinnedBlockNumber from fixture: ${usdcRoute.blockNumber}`,
      );

      const dexHelper = new DummyDexHelper(network);

      const usdcIn = 3_000n * 10n ** 6n; // 3,000 USDC
      assert(
        BigInt(usdcRoute.srcAmount) === usdcIn,
        `Fixture srcAmount mismatch (expected ${usdcIn.toString()}, got ${
          usdcRoute.srcAmount
        })`,
      );

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
      //    Seamless leg as the last leg. With dexFuncHasRecipient=false, the executor will append the final transfer
      //    of LT shares to Augustus.
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
      logRouteSummary(
        'Composed route summary: USDC -> ... -> wstETH -> WSTETH-ETH-25x (SELL)',
        composedRoute,
      );
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
        /* forceSimulationAPI */ !useVNetForSimulation,
      );

      if (!simulation.status) {
        const { transaction } = await tenderlySimulator.simulateTransaction(
          simulationRequest,
          // Always use Simulation API for trace fetching (avoids VNet fork-block mismatch issues).
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
