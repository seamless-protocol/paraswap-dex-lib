# Seamless Protocol

## Overview

Seamless Protocol is a DeFi lending/borrowing protocol (initially built on an Aave v3 fork) that migrated core lending
activity to Morpho to focus on building higher-level periphery and strategy primitives.

The primary primitive relevant to this repo is **Leverage Tokens (LTs)**: ERC-20 share tokens that represent an
automated leveraged position. Users can mint/redeem LT shares through Seamless periphery (flashloan + internal swaps +
manager accounting), and aggregators can integrate that mint/redeem path as a DEX-like “venue” leg.

This folder (`src/dex/seamless-protocol/`) implements (or scaffolds) a **ParaSwap DexLib “DEX module”** for Seamless LTs.

## Status (Implemented vs Outstanding)

**Implemented**

- SELL + BUY pricing for collateral ↔ LT using **native previews**:
  - mint: `LeverageRouter.previewDeposit(...)`
  - redeem: `LeverageManager.previewRedeem(...)` / `previewWithdraw(...)`
- Mint exact-out (BUY) uses offchain **binary search** over `previewDeposit(...)` to find `collateralFromSender`.
- Venue execution calls `LeverageRouter.deposit(...)` / `redeem(...)` directly with:
  - `dexFuncHasRecipient=false`
  - no `returnAmountPos`
  - `minShares` / `minCollateralForSender = destAmount`
- Internal swapCalls via Velora `/swap` (v6.2):
  - debtAsset → collateral (SELL exact-in) for mint
  - collateral → debtAsset (BUY exact-out) for redeem
- Static market config, synthetic `getTopPoolsForToken`, integration + E2E tests.

**Outstanding**

- Optional dedicated `LeverageDexRouter` surface (explicit receiver/returnAmountPos, refund semantics).
- Optional Mode 2 (AnyToken → LT inside Seamless via `preCalls`/`postCalls`).
- Optional event-based pricing/state pool.
- Upstream PR to `paraswap/paraswap-dex-lib` (see checklist below).

**Outstanding: ParaSwap DexLib upstream PR checklist** (from `paraswap-dex-lib/README.md`)

- Fork `paraswap-dex-lib` and create a feature branch.
- `yarn install`.
- Ensure `src/dex/seamless-protocol/` is complete and `src/dex/index.ts` includes `SeamlessProtocol`.
- Run `yarn test-integration seamless-protocol`.
- Open a PR to `paraswap/paraswap-dex-lib` `master` with DEX background, pricing logic, links to docs, and contract
  addresses.

## Seamless and Velora

Velora (ParaSwap/Augustus) is an aggregator execution engine. The intended integration model here is **ParaSwap Mode 1
(ParaSwap-as-venue)**:

- ParaSwap routes **AnyToken ↔ collateral** using its existing DEX legs.
- Seamless is called only for the **collateral ↔ LT** leg.
- Internally, leveraged mint/redeem still requires an **internal leverage swap** (`debtAsset ↔ collateral`) during the
  flashloan lifecycle, executed via Seamless periphery using `IMulticallExecutor.Call[]` (“swapCalls” / “leverageCalls”).

Current implementation for the internal leverage swap route:

- We use **Velora Market API v6.2 → tx calldata → wrap as `IMulticallExecutor.Call[]`** for internal swaps:
  - mint: `debtAsset -> collateral` (SELL exact-in)
  - redeem: `collateral -> debtAsset` (BUY exact-out)
- This means the internal swapCalls will often call **Augustus** and is therefore a **nested Augustus** call graph in
  Mode 1 (`Augustus (outer) → Seamless venue → multicallExecutor → Augustus (inner)`).
- This has known tradeoffs:
  - Augustus may retain dust on itself for some fee-transfer paths (not sweepable by Seamless).
  - We still enforce “no stranded balances” on Seamless custody addresses (executor/router/multicallExecutor), but we do
    not require Augustus itself to end at exact-zero.
- Deep dive + experiments: `john-onboarding/design/dex-integration/InternalLeverageSwap.md`.

## ParaSwap-recommended flow (pricing vs tx build)

ParaSwap guidance: **avoid external API calls in `getPricesVolume`** and allow them in `getDexParam`. The Seamless module
follows this split:

- **Pricing (`getPricesVolume`)** uses only onchain previews:
  - mint: `LeverageRouter.previewDeposit(...)`
  - redeem: `LeverageManager.previewRedeem/previewWithdraw(...)`
  - **no external API calls**
- **Tx build (`getDexParam`)** can call Velora `/swap` to build internal `swapCalls`:
  - happens once per Seamless leg when building a transaction
  - always calls the live API

## Design

Current scope supports both mint and redeem, SELL and BUY:

- Pools are advertised for **collateral ↔ LT** in both directions when enabled by config.
- Pool identifier format (normative): `${dexKey}_${ltAddressLower}` (e.g. `SeamlessProtocol_0x...`).
- Quoting uses native previews:
  - mint exact-in: `LeverageRouter.previewDeposit(...)`
  - mint exact-out: offchain binary search over `previewDeposit(...)`
  - redeem exact-in: `LeverageManager.previewRedeem(...)`
  - redeem exact-out: `LeverageManager.previewWithdraw(...)`
- Mint flashloan sizing uses **raw** `previewDeposit(...).debt` (no buffer) so `destAmount` matches output.
- Redeem pricing applies a **conservative buffer** to the preview results:
  - SELL redeem: reduce `collateralOut` by `SEAMLESS_INTERNAL_SWAP_BUFFER_BPS`
  - BUY redeem: increase `sharesIn` (and the derived flashLoan sizing) by the same buffer
  - This keeps pricing API-free while accounting for internal swap costs.

**Top pools behavior (`getTopPoolsForToken`)**

DexLib requires `getTopPoolsForToken(token, limit)` so the pool tracker/pathfinder can discover liquidity candidates.
For SeamlessProtocol, there is no AMM pool; we treat each LT market as a “pool” and return synthetic “infinite”
liquidity entries driven by static market config:

- If `token` is a **collateral token**, return all configured LT markets that use that collateral (connector token is
  the LT).
- If `token` is an **LT token**, return the corresponding market (connector token is the collateral).
- Otherwise, return `[]`.

**Execution surface (implemented):** ParaSwap venue legs call `LeverageRouter.deposit(...)` /
`LeverageRouter.redeem(...)` directly with `dexFuncHasRecipient=false`. Output lands on the **executor** first, and
ParaSwap appends a final transfer of `destAmount` to Augustus.

## Native LeverageRouter execution surface

ParaSwap V6 venue legs can execute **without a per-leg recipient** by setting `dexFuncHasRecipient=false`. In this
mode, the executor appends a final transfer of `destAmount` to Augustus when the Seamless leg is the last leg.

Implications:

- Venue target is `LeverageRouter.deposit(...)` / `LeverageRouter.redeem(...)`.
- `returnAmountPos` is undefined.
- `minShares` / `minCollateralForSender` must equal the quoted `destAmount`.
- Output lands on the executor first; any excess remains on the executor.

### Function surface (native)

```solidity
function deposit(
  address leverageToken,
  uint256 collateralFromSender,
  uint256 flashLoanAmount,
  uint256 minShares,
  address multicallExecutor,
  IMulticallExecutor.Call[] calldata swapCalls
) external;

function redeem(
  address leverageToken,
  uint256 shares,
  uint256 minCollateralForSender,
  address multicallExecutor,
  IMulticallExecutor.Call[] calldata swapCalls
) external;
```

### Where the contracts live

- `LeverageRouter` and `LeverageManager` are part of `leverage-tokens`.
- DexLib uses ABIs under `src/abi/seamless-protocol/`:
  - `LeverageRouter.json`
  - `LeverageManager.json`
  - `MulticallExecutor.json`

**Internal leverage swap route (`swapCalls`)**

Leveraged mint/redeem requires internal swaps during the flashloan lifecycle, executed by the Seamless
`multicallExecutor`:

- Mint: `debtAsset -> collateral` (SELL exact-in, `amountIn = flashLoanAmount`)
- Redeem: `collateral -> debtAsset` (BUY exact-out, `amountOut = flashLoanAmount`)

We build `swapCalls` via **Velora Market API v6.2**:

- fetch swap tx calldata for the required direction
- set `userAddress = multicallExecutor` and `receiver = multicallExecutor`
- wrap into Seamless call list:
  1. `approve(srcToken, augustusV6.2, approvalAmount)`
  2. `{ target: augustusV6.2, value: tx.value, data: tx.data }`

This introduces nested Augustus in Mode 1; Augustus may retain dust on itself (not sweepable). Invariants to enforce:

- `userAddress == receiver == multicallExecutor` (so `msg.sender` and custody model match)
- `txParams.to` MUST be an allowlisted Augustus address for `(chainId, version)` (do not blindly trust API output)
- `txParams.value == 0` (native ETH swaps are not supported)
- approval spender MUST equal `txParams.to`
- Seamless custody addresses must end clean (tracked tokens == 0):
  - `multicallExecutor` (collateral + debtAsset)
  - `LeverageRouter` (as much as feasible)
- Augustus dust is tolerated but should be measured/logged

Deep dive + experiments: `john-onboarding/design/dex-integration/InternalLeverageSwap.md`.

### Implementation status (done)

1. **Pricing uses native previews**
   - mint: `LeverageRouter.previewDeposit(...)`
   - redeem: `LeverageManager.previewRedeem(...)` / `previewWithdraw(...)`
   - mint exact-out uses offchain binary search over `previewDeposit(...)`
2. **Venue encoding uses `LeverageRouter` directly**
   - `SeamlessProtocol.getDexParam(...)` encodes `LeverageRouter.deposit(...)` / `redeem(...)`
   - `dexFuncHasRecipient=false`, `returnAmountPos` unset
   - `insertFromAmountPos = 36`
3. **ABI + config wiring exists**
   - ABIs: `src/abi/seamless-protocol/LeverageRouter.json`, `LeverageManager.json`, `MulticallExecutor.json`
   - Config: `seamlessCore.leverageManager` + `seamlessPeriphery.leverageRouter` / `multicallExecutor`

### Operational requirements for real onchain execution (outstanding)

1. **Broadcast path**
   - DexLib E2E uses Tenderly simulation only. A “real swap” requires broadcasting the built transaction from an EOA
     or keeper (see `seamless-keeper/src/integrations/velora/README.md`).
2. **Approvals + funding**
   - The sender must hold `tokenIn` and approve the ParaSwap V6 spender/transfer proxy used by the route.
   - For the Seamless venue leg, the ParaSwap executor calls `LeverageRouter.deposit(...)` / `redeem(...)`, which pulls
     collateral or shares from `msg.sender` (the executor) — the executor must have custody at that moment (Mode 1).
3. **Execution environment choice**
   - For canonical mainnet addresses, prefer Tenderly Simulation API (unset `TENDERLY_VNET_ID`) so simulations use
     mainnet state directly.
   - Use Tenderly VNet only when you need VNet-only deployments/state; otherwise it can introduce “fork block” mismatch
     issues.
4. **Track execution slippage in E2E**
   - E2E validates quote vs simulation using a BPS tolerance.
   - Tune tolerance with `SEAMLESS_E2E_MAX_SLIPPAGE_BPS` if routing conditions change.

## Outstanding scope details

The remaining work is captured in the Outstanding list above and primarily covers a native `LeverageDexRouter`
surface, optional Mode 2 routing, and event-based pricing.

## Getting Started

1. Configure supported markets in `src/dex/seamless-protocol/config.ts` (static list per network).
2. Ensure token metadata exists in `tests/constants-e2e.ts` (address + decimals) for the markets you test.
3. Set up `.env` (see `.env.example`). Minimum for mainnet E2E-style simulations:

```bash
HTTP_PROVIDER_1=<mainnet RPC URL>
TENDERLY_TOKEN=...
TENDERLY_ACCOUNT_ID=...
TENDERLY_PROJECT=...

# Velora/ParaSwap Market API base URL used to build the *internal leverage swap route*
# (debtAsset -> collateral) via `GET /swap` inside `SeamlessProtocol.getDexParam`.
# Defaults to https://api.paraswap.io if unset.
VELORA_API_URL=https://api.paraswap.io

# Optional: buffer (in bps) applied to redeem pricing to cover internal swap cost.
# Defaults to the same bps used for /swap slippage (currently 100).
SEAMLESS_INTERNAL_SWAP_BUFFER_BPS=100

# Optional: max allowed quote-vs-sim divergence in E2E, in BPS.
# Default: 400 (4%).
SEAMLESS_E2E_MAX_SLIPPAGE_BPS=400

# If you want DexLib to price and route through the local SeamlessProtocol module:
# - unset E2E_TEST_ENDPOINT, OR
# - pass poolIdentifiers to testE2E(...)
E2E_TEST_ENDPOINT=

# Required by Native adapter constructor (even if Native not under test)
API_KEY_NATIVE=test
```

Implementation notes:

- `SeamlessProtocolEventPool` is intentionally disabled (no event-driven caching).
- The E2E harness uses `TenderlySimulator.DEFAULT_OWNER` as the effective sender unless modified; ensure state overrides
  apply to that address when debugging.

## Testing

This module follows the standard DexLib test structure (integration / events / e2e). Currently:

- Integration tests validate pool discovery, pricing, and `getTopPoolsForToken`.
- EventPool tests are intentionally skipped (EventPool disabled).
- E2E tests execute the native LeverageRouter flow and assert the Tenderly simulation succeeds.

### What “E2E” means in this repo (important)

DexLib “E2E” tests in this repository **simulate** transactions; they do **not** broadcast signed transactions to an
RPC.

There are two separate “execution surfaces” involved:

1. **Onchain reads / quoting RPC**
   - Used for ERC20 `decimals()` and preview functions (`previewDeposit`, `previewRedeem`, `previewWithdraw`), etc.
   - Comes from `HTTP_PROVIDER_1` (DexHelper private provider).
2. **Tenderly Simulation API (REST)**
   - Used to “run” the transaction by simulating it against mainnet state at the quote route `block_number`, with
     `state_objects` overrides (balances/allowances).
   - This is what makes tests deterministic without private keys or real funding.
   - Default path for SeamlessProtocol E2E is **Simulation API against mainnet state** (not VNet).

If you want to simulate against a Tenderly VNet instead of mainnet state, you must set:

- `TENDERLY_VNET_ID=<...>`
- `SEAMLESS_E2E_USE_VNET=1`

Otherwise SeamlessProtocol E2E will force Simulation API even if `TENDERLY_VNET_ID` is set.

### Live API behavior and slippage checks

E2E now uses live API responses for route construction and validates execution with a BPS tolerance:

- AnyToken E2E (USDC -> ... -> wstETH -> LT) fetches a live ParaSwap route, appends the local Seamless leg, and then
  checks quote-vs-simulation divergence in BPS.
- Use `SEAMLESS_E2E_MAX_SLIPPAGE_BPS` to tune tolerance for CI/runtime conditions.
- The LT -> collateral redeem simulation is currently skipped in fixture-free mode due upstream live-route instability.

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

# E2E (native LeverageRouter; should succeed)
yarn test src/dex/seamless-protocol/seamless-protocol-e2e.test.ts
```

### Required env vars (minimum for mainnet Simulation API E2E)

```bash
# Onchain reads (previews, decimals, etc.)
HTTP_PROVIDER_1=<mainnet RPC URL>

# Tenderly Simulation API (REST)
TENDERLY_TOKEN=...
TENDERLY_ACCOUNT_ID=...
TENDERLY_PROJECT=...

# Velora/ParaSwap API base URL used to build the *internal leverage swap route* (debtAsset -> collateral)
VELORA_API_URL=https://api.paraswap.io

# Max allowed quote-vs-sim divergence in E2E, in BPS
SEAMLESS_E2E_MAX_SLIPPAGE_BPS=400
```

### Testing enhancements (optional)

#### Broadcast-to-VNet runner (optional)

This repo’s Jest E2E tests intentionally simulate (no signing, no broadcasting).

If you want an optional “broadcast to Tenderly VNet” runner for deeper debugging:

- Start from the same tx-building path (LocalParaswapSDK + GenericSwapTransactionBuilder).
- Use a funded private key on a Tenderly VNet fork.
- Broadcast `eth_sendRawTransaction` to the VNet RPC endpoint and inspect receipts/traces.

This is optional and not enabled by default because it is slower, requires key management + funding, and is less
deterministic than Simulation API.

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
