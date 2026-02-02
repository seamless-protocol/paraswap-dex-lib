# Seamless Protocol

## Overview

Seamless Protocol is a DeFi lending/borrowing protocol (initially built on an Aave v3 fork) that migrated core lending
activity to Morpho to focus on building higher-level periphery and strategy primitives.

The primary primitive relevant to this repo is **Leverage Tokens (LTs)**: ERC-20 share tokens that represent an
automated leveraged position. Users can mint/redeem LT shares through Seamless periphery (flashloan + internal swaps +
manager accounting), and aggregators can integrate that mint/redeem path as a DEX-like “venue” leg.

This folder (`src/dex/seamless-protocol/`) implements (or scaffolds) a **ParaSwap DexLib “DEX module”** for Seamless LTs.

## Seamless and Velora

Velora (ParaSwap/Augustus) is an aggregator execution engine. The intended integration model here is **ParaSwap Mode 1
(ParaSwap-as-venue)**:

- ParaSwap routes **AnyToken ↔ collateral** using its existing DEX legs.
- Seamless is called only for the **collateral ↔ LT** leg.
- Internally, leveraged mint/redeem still requires an **internal leverage swap** (`debtAsset ↔ collateral`) during the
  flashloan lifecycle, executed via Seamless periphery using `IMulticallExecutor.Call[]` (“swapCalls” / “leverageCalls”).

In Phase 1 we avoid “nested Augustus” (calling Velora from inside the internal leverage swap call list) because it
doesn’t fit the multicall sweep + dust invariants and creates a brittle call graph.

## Design

Phase 1 scope is intentionally narrow and SELL/mint-first:

- The module advertises pools only for **SELL collateral → LT** (mint-like leg).
- Pool identifier format (normative): `${dexKey}_${ltAddressLower}` (e.g. `SeamlessProtocol_0x...`).
- BUY is intentionally unsupported in Phase 1 (pool discovery returns `[]`, pricing returns `null`).
- Quoting uses Seamless protocol previews (Phase 1: `LeverageRouter.previewDeposit`) and carries the derived
  `flashLoanAmount` forward into tx-building because `getDexParam` does not receive `blockNumber`.

**Top pools behavior (`getTopPoolsForToken`)**

DexLib requires `getTopPoolsForToken(token, limit)` so the pool tracker/pathfinder can discover liquidity candidates.
For SeamlessProtocol, there is no AMM pool; we treat each LT market as a “pool” and return synthetic “infinite”
liquidity entries driven by static market config:

- If `token` is a **collateral token**, return all configured LT markets that use that collateral (connector token is
  the LT).
- If `token` is an **LT token**, return the corresponding market (connector token is the collateral).
- Otherwise, return `[]`.

Execution is planned in two gates:

- **Gate 0:** validate internal swapCalls encoding end-to-end using the existing `LeverageRouter.deposit(...)` surface.
  This is useful for proving the internal leverage swap calldata and `flashLoanAmount` sizing, but it is not a real
  ParaSwap venue leg (no explicit receiver, no return value for `returnAmountPos`). In practice Gate 0 must be executed
  as a **non-recipient-aware** venue: `LeverageRouter.deposit(...)` always mints to `msg.sender` and returns no amount,
  so it cannot satisfy ParaSwap V6 “per-leg recipient + returnAmountPos” expectations for a venue leg.
- **Gate 1 (Phase 1 workaround):** call a thin wrapper contract (`LeverageRouterRecipientWrapper`) as the venue target.
  It calls `LeverageRouter.deposit(...)` and then (a) forwards minted LT shares to the per-leg `recipient`, and (b)
  returns `sharesOut` as the first return value (`returnAmountPos=0`).
  - In E2E tests, we inject the wrapper bytecode via Tenderly `stateOverride.code` (no onchain deployment needed).
  - Long-term, this wrapper is replaced by a dedicated `LeverageDexRouter` surface.

## Getting Started

1. Configure supported markets in `src/dex/seamless-protocol/config.ts` (static list per network).
2. Ensure token metadata exists in `tests/constants-e2e.ts` (address + decimals) for the markets you test.
3. Set up `.env` (see `.env.example`). Minimum for mainnet E2E-style simulations:

```bash
HTTP_PROVIDER_1=<mainnet RPC URL>
TENDERLY_TOKEN=...
TENDERLY_ACCOUNT_ID=...
TENDERLY_PROJECT=...

# If you want DexLib to price and route through the local SeamlessProtocol module:
# - unset E2E_TEST_ENDPOINT, OR
# - pass poolIdentifiers to testE2E(...)
E2E_TEST_ENDPOINT=

# Required by Native adapter constructor (even if Native not under test)
API_KEY_NATIVE=test
```

Implementation notes:

- `SeamlessProtocolEventPool` is intentionally disabled in Phase 1 (no event-driven caching).
- The E2E harness uses `TenderlySimulator.DEFAULT_OWNER` as the effective sender unless modified; ensure state overrides
  apply to that address when debugging.

## Testing

This module follows the standard DexLib test structure (integration / events / e2e). In Phase 1:

- Integration tests validate pool discovery, pricing, and `getTopPoolsForToken`.
- EventPool tests are intentionally skipped (EventPool disabled).
- E2E tests execute the Gate 1 wrapper flow and assert the Tenderly simulation succeeds (recipient wiring + returnAmountPos).

```bash
# All integration tests for this DEX module
yarn test-integration seamless-protocol

# Individual test files
yarn test src/dex/seamless-protocol/seamless-protocol-integration.test.ts
yarn test src/dex/seamless-protocol/seamless-protocol-e2e.test.ts
yarn test src/dex/seamless-protocol/seamless-protocol-events.test.ts

# Focused tests
yarn test src/dex/seamless-protocol/seamless-protocol-integration.test.ts -t 'getPoolIdentifiers and getPricesVolume SELL'
yarn test src/dex/seamless-protocol/seamless-protocol-integration.test.ts -t 'getTopPoolsForToken'

# Gate 1 E2E (wrapper; should succeed)
yarn test src/dex/seamless-protocol/seamless-protocol-e2e.test.ts
```
