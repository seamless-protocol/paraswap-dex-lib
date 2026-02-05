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

- SELL + BUY pricing for collateral ↔ LT using `DexLeverageRouter` quote helpers.
- Wrapper venue execution: `getDexParam` encodes `DexLeverageRouter.depositToRecipient(...)` and
  `redeemToRecipient(...)` with `returnAmountPos = 0` and `insertFromAmountPos = 36`.
- Internal swapCalls via Velora `/swap` (v6.2):
  - debtAsset → collateral (SELL exact-in) for mint
  - collateral → debtAsset (BUY exact-out) for redeem
- Static market config, synthetic `getTopPoolsForToken`, integration + E2E tests.

**Outstanding**

- Replace the wrapper with a dedicated `LeverageDexRouter` (native receiver/refund + exact-in/out surfaces).
- Optional Mode 2 (AnyToken → LT inside Seamless via `preCalls`/`postCalls`).
- Deploy/config `DexLeverageRouter` on Base (currently disabled in config).
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

- We use **Velora Market API v6.2 → tx calldata → wrap as `IMulticallExecutor.Call[]`** for the internal
  `debtAsset -> collateral` swap during the flashloan lifecycle.
- This means the internal swapCalls will often call **Augustus** and is therefore a **nested Augustus** call graph in
  Mode 1 (`Augustus (outer) → Seamless venue → multicallExecutor → Augustus (inner)`).
- This has known tradeoffs:
  - Augustus may retain dust on itself for some fee-transfer paths (not sweepable by Seamless).
  - We still enforce “no stranded balances” on Seamless custody addresses (wrapper/router/multicallExecutor), but we do
    not require Augustus itself to end at exact-zero.
- Deep dive + experiments: `john-onboarding/design/dex-integration/InternalLeverageSwap.md`.

## Design

Current scope supports both mint and redeem, SELL and BUY:

- Pools are advertised for **collateral ↔ LT** in both directions when enabled by config.
- Pool identifier format (normative): `${dexKey}_${ltAddressLower}` (e.g. `SeamlessProtocol_0x...`).
- Quoting uses `DexLeverageRouter` view helpers (exact-in/out), which return both output amounts and the
  `flashLoanAmount` needed to build internal swapCalls.
  - For mint, DexLib uses the **buffered** `flashLoanAmount` for SELL and the **raw** `flashLoanAmount` for BUY
    to avoid under-borrowing on exact-out routes.
  - For redeem, DexLib conservatively **subtracts estimated collateral spent** to buy debt for repayment using a
    Velora `/swap` quote (linear scaling from the last amount in the price grid).

**Top pools behavior (`getTopPoolsForToken`)**

DexLib requires `getTopPoolsForToken(token, limit)` so the pool tracker/pathfinder can discover liquidity candidates.
For SeamlessProtocol, there is no AMM pool; we treat each LT market as a “pool” and return synthetic “infinite”
liquidity entries driven by static market config:

- If `token` is a **collateral token**, return all configured LT markets that use that collateral (connector token is
  the LT).
- If `token` is an **LT token**, return the corresponding market (connector token is the collateral).
- Otherwise, return `[]`.

**Execution surface (implemented):** ParaSwap venue legs call the recipient-aware wrapper
`DexLeverageRouter.depositToRecipient(...)`, which forwards minted shares to the per-leg `recipient` and returns
`sharesOut` as the first return value (`returnAmountPos=0`). `LeverageRouter.deposit(...)` alone is not a valid ParaSwap
venue leg because it has no `receiver` and returns no output amount.

## DexLeverageRouter (execution surface)

This section documents the **minimum onchain surface** required for ParaSwap V6 “venue legs”.

### Why a wrapper is required (ParaSwap V6 execution semantics)

In ParaSwap V6, each leg is built with a per-leg `recipient`. For SELL routes, the **final leg** expects output to be
held on that `recipient` (often the Augustus address itself).

`LeverageRouter.deposit(...)` is not a valid ParaSwap venue leg because:

- It mints LT shares to `msg.sender` (no `receiver` parameter).
- It returns no `uint256` output, so ParaSwap cannot set `returnAmountPos` for accounting.

### Contract naming

In `paraswap-dex-lib` we call the wrapper venue target:

- `DexLeverageRouter` (recipient-aware wrapper around `LeverageRouter.deposit(...)`).

What matters is that the ABI matches the `DexLeverageRouter` interface used by the DexLib module (see
`src/abi/seamless-protocol/DexLeverageRouter.json`).

### Implementation home (Solidity)

All Solidity deliverables for this integration should be implemented in:

- `seamless-intents/` (Option B), which consumes `leverage-tokens` as a git submodule.

This keeps execution surfaces out of `leverage-tokens` while still reusing its canonical protocol interfaces and
periphery.

### Minimal function surface (mint + redeem)

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

Redeem entrypoint used for **LT -> collateral**:

```solidity
function redeemToRecipient(
    address leverageToken,
    uint256 sharesIn,
    uint256 minCollateralForSender,
    address multicallExecutor,
    IMulticallExecutor.Call[] calldata swapCalls,
    address leverageRouter,
    address receiver,
    address refundRecipient
) external returns (uint256 collateralOut);
```

Expected semantics:

- Pull `collateralFromSender` from `msg.sender` (ParaSwap executor) into the wrapper.
- Call `LeverageRouter.deposit(...)` from the wrapper:
  - Shares are minted to the wrapper.
  - The internal leverage `swapCalls` run inside the flashloan lifecycle via the configured `multicallExecutor`.
- Transfer all minted shares to `receiver` (DexLib per-leg `recipient`).
- Refund any dust to `refundRecipient` (current default uses `refundRecipient = receiver`).
- Return `sharesOut` as the **first** return value (`returnAmountPos = 0`).

Wrapper hardening (implemented in `seamless-intents/src/velora/DexLeverageRouter.sol`):

- `depositToRecipient` is `nonReentrant`.
- `sharesOut = sharesAfter - sharesBefore`, with `sharesOut >= minShares` enforced.
- Approval hygiene: approve exact amount and reset approval back to `0`.
- Dust hygiene: refund collateral/debt dust to `refundRecipient`.
- Parameter validation: non-zero `leverageToken`, `multicallExecutor`, `leverageRouter`, `receiver`, `refundRecipient`,
  and derived `collateralAsset/debtAsset`.

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
  - `DexLeverageRouter` wrapper (collateral + debtAsset + LT shares)
  - `LeverageRouter` (as much as feasible)
- Augustus dust is tolerated but should be measured/logged

Deep dive + experiments: `john-onboarding/design/dex-integration/InternalLeverageSwap.md`.

### Implementation status (done)

1. **Wrapper venue encoding is implemented**
   - `SeamlessProtocol.getDexParam(...)` encodes:
     - `DexLeverageRouter.depositToRecipient(...)` for mint, and
     - `DexLeverageRouter.redeemToRecipient(...)` for redeem
   - `returnAmountPos = 0` (first return value)
   - `insertFromAmountPos = 36` (patches the src amount arg)
   - code: `src/dex/seamless-protocol/seamless-protocol.ts`
2. **ABI + config wiring exists**
   - ABI: `src/abi/seamless-protocol/DexLeverageRouter.json`
   - Config field: `seamlessPeriphery.dexLeverageRouter` in `src/dex/seamless-protocol/config.ts`
3. **Internal leverage swap route builder exists (Velora /swap)**

   - Built as multicall `swapCalls` (`approve(0)`, `approve(amount)`, `call(augustus, tx.data)`).
   - Strict fixture support:
     - `SEAMLESS_VELORA_SWAP_FIXTURES_PATH`
     - `SEAMLESS_VELORA_SWAP_FIXTURES_STRICT`
   - code: `src/dex/seamless-protocol/seamless-protocol.ts`

4. **`DexLeverageRouter` is deployed on Ethereum mainnet**
   - Mainnet wrapper venue target (has code): `0x03926d5E64aF50b575fDba4B490863dDf26bEd58`
   - Deployment block number: `24387031`
   - `src/dex/seamless-protocol/config.ts` treats this as the canonical mainnet address.
   - **Important:** any pinned `blockNumber` used for E2E must be `>= 24387031`; otherwise the Seamless leg reverts
     because `DexLeverageRouter` has no code yet at that block.

### Operational requirements for real onchain execution (outstanding)

1. **Broadcast path**
   - DexLib E2E uses Tenderly simulation only. A “real swap” requires broadcasting the built transaction from an EOA
     or keeper (see `seamless-keeper/src/integrations/velora/README.md`).
2. **Approvals + funding**
   - The sender must hold `tokenIn` and approve the ParaSwap V6 spender/transfer proxy used by the route.
   - For the Seamless venue leg, the ParaSwap executor calls `DexLeverageRouter.depositToRecipient(...)`, which pulls
     collateral from `msg.sender` (the executor) — the executor must have custody at that moment (Mode 1 semantics).
3. **Execution environment choice**
   - For canonical mainnet addresses, prefer Tenderly Simulation API (unset `TENDERLY_VNET_ID`) so simulations use
     mainnet state directly.
   - Use Tenderly VNet only when you need VNet-only deployments/state; otherwise it can introduce “fork block” mismatch
     issues.
4. **Keep fixtures deterministic for CI**
   - CI should run with strict fixtures so internal swap calldata does not drift as routing changes.
   - Local iteration can remain non-strict (fallback to live `/swap`) until you decide to fully freeze.
   - Optional convenience for local fixture authoring:
     - set `SEAMLESS_VELORA_SWAP_FIXTURES_WRITE=1` to append missing `/swap` fixtures to
       `SEAMLESS_VELORA_SWAP_FIXTURES_PATH` (do not enable in CI).

Since `DexLeverageRouter` is mainnet-deployed, forks and generic Tenderly simulations can treat it as a normal onchain
dependency (no bytecode injection required). VNets become a dev-only tool rather than a requirement.

## Outstanding scope details

The remaining work is captured in the Outstanding list above and primarily covers a native `LeverageDexRouter`
surface, optional Mode 2 routing, Base deployment, and event-based pricing.

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

# Optional: freeze Velora `/swap` responses for deterministic E2E.
# When set, SeamlessProtocol will load fixtures from this file and use them instead of calling the live API.
SEAMLESS_VELORA_SWAP_FIXTURES_PATH=tests/fixtures/seamless-protocol/velora-swap.json
# If set to `1`, missing fixtures are a hard error (no fallback to live API).
# Recommendation:
# - CI: strict (`CI=true` in the test environment; E2E enables strict mode by default)
# - local: non-strict (allows fallback to live API if a fixture is missing)
SEAMLESS_VELORA_SWAP_FIXTURES_STRICT=0
# If set to `1` (local only), missing fixtures are fetched from the live API and appended to
# `SEAMLESS_VELORA_SWAP_FIXTURES_PATH` automatically.
# Do NOT enable this in CI.
SEAMLESS_VELORA_SWAP_FIXTURES_WRITE=0

# Optional: pin block number in E2E (keeps quote helpers + fixture keys in sync).
# MUST be >= 24387031 (DexLeverageRouter deployment block).
SEAMLESS_E2E_PINNED_BLOCK_NUMBER=24387094

# Optional: freeze ParaSwap `/prices` (getRate) response used by SeamlessProtocol E2E test 3 (USDC -> wstETH leg).
# When set, the test will load the fixture instead of calling the live ParaSwap API.
SEAMLESS_PARASWAP_RATE_FIXTURE_PATH=tests/fixtures/seamless-protocol/paraswap-rate-usdc-wsteth.json

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
- E2E tests execute the wrapper flow and assert the Tenderly simulation succeeds (recipient wiring +
  `returnAmountPos`).

### What “E2E” means in this repo (important)

DexLib “E2E” tests in this repository **simulate** transactions; they do **not** broadcast signed transactions to an
RPC.

There are two separate “execution surfaces” involved:

1. **Onchain reads / quoting RPC**
   - Used for ERC20 `decimals()`, `DexLeverageRouter` quote helpers (which call preview functions), etc.
   - Comes from `HTTP_PROVIDER_1` (DexHelper private provider).
2. **Tenderly Simulation API (REST)**
   - Used to “run” the transaction by simulating it against mainnet state at a pinned `block_number`, with
     `state_objects` overrides (balances/allowances).
   - This is what makes tests deterministic without private keys or real funding.
   - Default path for SeamlessProtocol E2E is **Simulation API against mainnet state** (not VNet).

If you want to simulate against a Tenderly VNet instead of mainnet state, you must set:

- `TENDERLY_VNET_ID=<...>`
- `SEAMLESS_E2E_USE_VNET=1`

Otherwise SeamlessProtocol E2E will force Simulation API even if `TENDERLY_VNET_ID` is set.

### Determinism: pinned blocks + fixtures

E2E determinism hinges on keeping `blockNumber` and frozen fixtures aligned:

- `DexLeverageRouter` existence: pinned block must be `>= 24387031` (deployment block).
- Internal leverage swap route fixtures:
  - `tests/fixtures/seamless-protocol/velora-swap.json` freezes Velora `/swap` txParams for the internal swapCalls
    (debtAsset -> collateral).
  - In CI, run with strict fixtures so tests never call live `/swap` (see env vars below).
  - If you change the pinned block, quote outputs (`previewDeposit` under the hood) change slightly → `flashLoanAmount` changes
    → you will need a new `/swap` fixture entry for the new key.
- AnyToken E2E (USDC -> ... -> wstETH -> LT) also uses a frozen ParaSwap `/prices` fixture:
  - `tests/fixtures/seamless-protocol/paraswap-rate-usdc-wsteth.json`
  - This pins the intermediate wstETH amount _and_ provides the `blockNumber` for that test.
  - **Fixture gotcha:** if `DexLeverageRouter` is deployed after the fixture’s `blockNumber`, the AnyToken E2E must be
    updated with a new fixture (blockNumber must be >= deploy).

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

# E2E (wrapper; should succeed)
yarn test src/dex/seamless-protocol/seamless-protocol-e2e.test.ts
```

### Required env vars (minimum for mainnet Simulation API E2E)

```bash
# Onchain reads (quote helpers, decimals, etc.)
HTTP_PROVIDER_1=<mainnet RPC URL>

# Tenderly Simulation API (REST)
TENDERLY_TOKEN=...
TENDERLY_ACCOUNT_ID=...
TENDERLY_PROJECT=...

# Pinned block for the single-leg E2E (wstETH -> LT)
# MUST be >= 24387031 (DexLeverageRouter deployment block).
SEAMLESS_E2E_PINNED_BLOCK_NUMBER=24387094

# Velora/ParaSwap API base URL used to build the *internal leverage swap route* (debtAsset -> collateral)
VELORA_API_URL=https://api.paraswap.io

# Freeze Velora /swap responses for deterministic E2E (recommended in CI)
SEAMLESS_VELORA_SWAP_FIXTURES_PATH=tests/fixtures/seamless-protocol/velora-swap.json
# In CI set to 1 (strict). Locally keep unset/0 to allow live `/swap` for faster iteration.
SEAMLESS_VELORA_SWAP_FIXTURES_STRICT=0

# Freeze ParaSwap /prices response for the AnyToken E2E (USDC -> ... -> LT)
SEAMLESS_PARASWAP_RATE_FIXTURE_PATH=tests/fixtures/seamless-protocol/paraswap-rate-usdc-wsteth.json
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
