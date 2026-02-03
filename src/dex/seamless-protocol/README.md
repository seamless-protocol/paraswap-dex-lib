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

Execution is planned in multiple Gates:

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

## DexLeverageRouter definition and steps to working swaps

This section documents the **minimum onchain surface** required for ParaSwap V6 “venue legs” and how we get from the
current Tenderly-simulation workaround to a real, onchain-executable integration.

### Why a wrapper is required (ParaSwap V6 execution semantics)

In ParaSwap V6, each leg is built with a per-leg `recipient`. For SELL routes, the **final leg** expects output to be
held on that `recipient` (often the Augustus address itself).

`LeverageRouter.deposit(...)` is not a valid ParaSwap venue leg because:

- It mints LT shares to `msg.sender` (no `receiver` parameter).
- It returns no `uint256` output, so ParaSwap cannot set `returnAmountPos` for accounting.

### Contract naming

In `paraswap-dex-lib` we call the Gate 1 venue target:

- `LeverageRouterRecipientWrapper` (aka “recipient-aware LeverageRouter wrapper”).

The deployed Solidity artifact can be named **`DexLeverageRouter`** (preferred naming) or keep the wrapper name — what
matters is that the ABI matches `LEVERAGE_ROUTER_RECIPIENT_WRAPPER_IFACE` used by the DexLib module.

### Implementation home (Solidity)

All Solidity deliverables for this integration should be implemented in:

- `seamless-intents/` (Option B), which consumes `leverage-tokens` as a git submodule.

This keeps execution surfaces out of `leverage-tokens` while still reusing its canonical protocol interfaces and
periphery.

### Minimal function surface (Phase 1: mint leg only)

The minimal state-changing entrypoint needed to make **collateral -> LT** (mint) work as a ParaSwap venue leg:

```solidity
function depositToRecipient(
    address leverageToken,
    uint256 collateralFromSender,
    uint256 flashLoanAmount,
    uint256 minShares,
    address multicallExecutor,
    IMulticallExecutor.Call[] calldata swapCalls,
    address leverageRouter,
    address receiver,
    address refundRecipient
) external returns (uint256 sharesOut);
```

Expected semantics:

- Pull `collateralFromSender` from `msg.sender` (ParaSwap executor) into the wrapper.
- Call `LeverageRouter.deposit(...)` from the wrapper:
  - Shares are minted to the wrapper.
  - The internal leverage `swapCalls` run inside the flashloan lifecycle via the configured `multicallExecutor`.
- Transfer all minted shares to `receiver` (DexLib per-leg `recipient`).
- Refund any dust to `refundRecipient` (Phase 1 uses `refundRecipient = receiver`).
- Return `sharesOut` as the **first** return value (`returnAmountPos = 0`).

**Future surfaces (not Phase 1):**

- A symmetric `redeemToRecipient(...)` for LT->collateral.
- View-only quote helpers (e.g., a quoter contract) to support BUY (exact-out) and stable offchain quoting.

### Steps to move from simulations to real swaps

Today, the E2E tests **inject wrapper bytecode** at an address like `0x1111...1111` using Tenderly `stateOverride.code`.
This is great for testing, but it does not exist onchain.

To make real swaps work:

1. Implement the wrapper contract in `seamless-intents` (Solidity) and compile.
2. Deploy it to the chain you are testing against (mainnet fork/VNet for now).
3. Update `paraswap-dex-lib/src/dex/seamless-protocol/config.ts`:
   - Set `seamlessPeriphery.leverageRouterRecipientWrapper` to the deployed wrapper address (not a dummy).
4. Update/adjust E2E tests:
   - Keep the code-injection path for “pure simulation” runs if useful, but add a mode that uses the deployed address
     directly (no `stateOverride.code`).
5. (Later) replace the wrapper with a full `LeverageDexRouter` if/when Mode 2 or exact-out surfaces are required.

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
yarn test src/dex/seamless-protocol/seamless-protocol-integration.test.ts -t "1. Check Markets Mainnet"
yarn test src/dex/seamless-protocol/seamless-protocol-integration.test.ts -t "2. Check Top Pools for Tokens"
yarn test src/dex/seamless-protocol/seamless-protocol-integration.test.ts -t "3. Check Sell Prices"
yarn test src/dex/seamless-protocol/seamless-protocol-integration.test.ts -t "4. Check Buy Prices"

# Gate 1 E2E (wrapper; should succeed)
yarn test src/dex/seamless-protocol/seamless-protocol-e2e.test.ts
```

## Mapping Phases to Tests

### Checking Market Configuration

`yarn test src/dex/seamless-protocol/seamless-protocol-integration.test.ts -t "1. Check Markets Mainnet"`

### Checking Price Quoting

### Checking Collateral to Leverage Token

### Checking Any Token to Leverage Token

### Checking Leverage Token to Collateral Token

### Checking Any Token to Collateral Token (via LT)

### Checking Event Driven Market Updates

```bash
yarn test src/dex/seamless-protocol/seamless-protocol-integration.test.ts -t "1. Check Markets Mainnet"
yarn test src/dex/seamless-protocol/seamless-protocol-integration.test.ts -t "2. Check Top Pools for Tokens"
yarn test src/dex/seamless-protocol/seamless-protocol-integration.test.ts -t "3. Check Sell Prices"
yarn test src/dex/seamless-protocol/seamless-protocol-integration.test.ts -t "4. Check Buy Prices"
yarn test src/dex/seamless-protocol/seamless-protocol-e2e.test.ts -t "1. Check Swap CollateralToken to LeverageToken: wstETH to WSTETH-ETH-25x"
yarn test src/dex/seamless-protocol/seamless-protocol-e2e.test.ts -t "2. Check Swap LeverageToken to CollateralToken: WSTETH-ETH-25x to wstETH"
yarn test src/dex/seamless-protocol/seamless-protocol-e2e.test.ts -t "3. Check Swap AnyToken to LeverageToken: USDC to WSTETH-ETH-25x"
yarn test src/dex/seamless-protocol/seamless-protocol-events.test.ts -t "1. Check New Token Published Event"
```

UNLIMITED_USD_LIQUIDITY is a hardcoded constant (1234567890)
