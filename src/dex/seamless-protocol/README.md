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

Phase 1 direction for the internal leverage swap route:

- We are moving to **Velora Market API v6.2 → tx calldata → wrap as `IMulticallExecutor.Call[]`** for the internal
  `debtAsset -> collateral` swap during the flashloan lifecycle.
- This means the internal swapCalls will often call **Augustus** and is therefore a **nested Augustus** call graph in
  Mode 1 (`Augustus (outer) → Seamless venue → multicallExecutor → Augustus (inner)`).
- This has known tradeoffs:
  - Augustus may retain dust on itself for some fee-transfer paths (not sweepable by Seamless).
  - We still enforce “no stranded balances” on Seamless custody addresses (wrapper/router/multicallExecutor), but we do
    not require Augustus itself to end at exact-zero.
- Deep dive + experiments: `john-onboarding/design/dex-integration/InternalLeverageSwap.md`.

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
- **Gate 1 (Phase 1 workaround):** call a thin wrapper contract (**`DexLeverageRouter`**, renamed from
  `LeverageRouterRecipientWrapper`) as the venue target. It calls `LeverageRouter.deposit(...)` and then (a) forwards
  minted LT shares to the per-leg `recipient`, and (b) returns `sharesOut` as the first return value
  (`returnAmountPos=0`).
  - In E2E tests, we call a deployed `DexLeverageRouter` address from `config.ts`.
  - Long-term, this wrapper is replaced by a dedicated `LeverageDexRouter` surface.

**Implementation rule (Phase 1):** any ParaSwap V6 “venue leg” execution MUST target **Gate 1** (`DexLeverageRouter`).
Gate 0 is debug-only and MUST NOT be used as a ParaSwap venue target.

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

- `DexLeverageRouter` (aka “recipient-aware LeverageRouter wrapper”; renamed from `LeverageRouterRecipientWrapper`).

What matters is that the ABI matches the `DexLeverageRouter` interface used by the DexLib module (see
`src/abi/seamless-protocol/DexLeverageRouter.json`).

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

Recommended wrapper hardening (Phase 1):

- `depositToRecipient` should be `nonReentrant`.
- Compute `sharesOut = sharesAfter - sharesBefore` and assert it matches expectations (e.g. `>= minShares`).
- Approval hygiene: approve exact amount and (optionally) reset approval back to `0` after the call.
- Dust hygiene: ensure the wrapper ends with `0` balance for tracked tokens (collateral + debt, and LT shares after transfer).
- Parameter validation: for production deployments, configure router/executor immutably or via allowlists; at minimum validate
  derived `collateralAsset/debtAsset` are sane for the given `leverageToken`.

**Internal leverage swap route (`swapCalls`)**

Even though the venue leg is “collateral -> LT”, leveraged mint still requires an internal swap during the flashloan
lifecycle (`debtAsset -> collateral`) executed by the Seamless `multicallExecutor`.

Phase 1 direction is to build those `swapCalls` via **Velora Market API v6.2** (Option A):

- fetch swap tx calldata for `debtAsset -> collateral` (SELL exact-in, `amountIn = flashLoanAmount`)
- set `userAddress = multicallExecutor` and `receiver = multicallExecutor`
- wrap into Seamless call list:
  1. `approve(debtAsset, augustusV6.2, amountIn)`
  2. `{ target: augustusV6.2, value: tx.value, data: tx.data }`

This introduces nested Augustus in Mode 1; Augustus may retain dust on itself (not sweepable). Phase 1 invariants
should be treated as enforceable requirements (builder assertions + tests):

- `userAddress == receiver == multicallExecutor` (so `msg.sender` and custody model match)
- `txParams.to` MUST be an allowlisted Augustus address for `(chainId, version)` (do not blindly trust API output)
- `txParams.value == 0` (Phase 1 forbids internal swaps that require native ETH)
- approval spender MUST equal `txParams.to`
- Seamless custody addresses must end clean (tracked tokens == 0):
  - `multicallExecutor` (collateral + debtAsset)
  - `DexLeverageRouter` wrapper (collateral + debtAsset + LT shares)
  - `LeverageRouter` (as much as feasible)
- Augustus dust is tolerated but should be measured/logged

Deep dive + experiments: `john-onboarding/design/dex-integration/InternalLeverageSwap.md`.

**Future surfaces (not Phase 1):**

- A symmetric `redeemToRecipient(...)` for LT->collateral.
- View-only quote helpers (e.g., a quoter contract) to support BUY (exact-out) and stable offchain quoting.

### Steps to move from simulations to real swaps

Earlier, the E2E tests injected wrapper bytecode at a dummy address (e.g. `0x1111...1111`) using Tenderly
`stateOverride.code`. The current Phase 1 path uses a deployed `DexLeverageRouter` address.

To make real swaps work:

1. Implement the wrapper contract in `seamless-intents` (Solidity) and compile.
2. Deploy it to the chain you are testing against (mainnet fork/VNet for now).
3. Update `paraswap-dex-lib/src/dex/seamless-protocol/config.ts`:
   - Set `seamlessPeriphery.dexLeverageRouter` to the deployed wrapper address.
4. Update/adjust E2E tests:
   - Ensure tests use the deployed wrapper address directly (no `stateOverride.code` injection).
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

# Velora/ParaSwap Market API base URL used to build the *internal leverage swap route*
# (debtAsset -> collateral) via `GET /swap` inside `SeamlessProtocol.getDexParam`.
# Defaults to https://api.paraswap.io if unset.
VELORA_API_URL=https://api.paraswap.io

# Optional: freeze Velora `/swap` responses for deterministic E2E.
# When set, SeamlessProtocol will load fixtures from this file and use them instead of calling the live API.
SEAMLESS_VELORA_SWAP_FIXTURES_PATH=tests/fixtures/seamless-protocol/velora-swap.json
# If set to `1`, missing fixtures are a hard error (no fallback to live API).
SEAMLESS_VELORA_SWAP_FIXTURES_STRICT=0

# Optional: pin block number in E2E (keeps previewDeposit + fixture keys in sync).
SEAMLESS_E2E_PINNED_BLOCK_NUMBER=24363228

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

## Sample DexLeverageRouter (recipient-aware LeverageRouter wrapper)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ILeverageManager} from "src/interfaces/ILeverageManager.sol";
import {ILeverageRouter} from "src/interfaces/periphery/ILeverageRouter.sol";
import {ILeverageToken} from "src/interfaces/ILeverageToken.sol";
import {IMulticallExecutor} from "src/interfaces/periphery/IMulticallExecutor.sol";

/// @notice Thin wrapper around LeverageRouter for aggregator venue compatibility.
/// @dev This contract is intentionally stateless (no constructor args) so it can be deployed via any mechanism
/// (or injected in a fork simulation) and pointed at an existing LeverageRouter per call.
contract DexLeverageRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeERC20 for ILeverageToken;

    /// @notice Deposit into a LeverageToken using an existing LeverageRouter, but deliver minted shares to `receiver`.
    /// @dev `collateralFromSender` is the "equity" amount in collateral token units (same as LeverageRouter.deposit).
    /// @param leverageToken LeverageToken to deposit into
    /// @param collateralFromSender Collateral asset amount from msg.sender to deposit (equity)
    /// @param flashLoanAmount Debt asset amount to flashloan
    /// @param minShares Minimum shares required (passed through to LeverageRouter)
    /// @param multicallExecutor Multicall executor used by LeverageRouter for swapCalls
    /// @param swapCalls Swap calls executed by `multicallExecutor` (debtAsset -> collateral)
    /// @param leverageRouter Existing LeverageRouter instance to execute against
    /// @param receiver Recipient of minted LT shares
    /// @param refundRecipient Recipient for any leftover collateral/debt dust on this wrapper
    /// @return sharesOut Amount of LT shares delivered to `receiver`
    function depositToRecipient(
        ILeverageToken leverageToken,
        uint256 collateralFromSender,
        uint256 flashLoanAmount,
        uint256 minShares,
        IMulticallExecutor multicallExecutor,
        IMulticallExecutor.Call[] calldata swapCalls,
        ILeverageRouter leverageRouter,
        address receiver,
        address refundRecipient
    ) external nonReentrant returns (uint256 sharesOut) {
        ILeverageManager leverageManager = leverageRouter.leverageManager();

        IERC20 collateralAsset = leverageManager.getLeverageTokenCollateralAsset(leverageToken);
        IERC20 debtAsset = leverageManager.getLeverageTokenDebtAsset(leverageToken);

        // Pull equity from caller into this wrapper and approve the router to pull it.
        collateralAsset.safeTransferFrom(msg.sender, address(this), collateralFromSender);
        collateralAsset.forceApprove(address(leverageRouter), collateralFromSender);

        uint256 sharesBefore = leverageToken.balanceOf(address(this));

        leverageRouter.deposit(
            leverageToken,
            collateralFromSender,
            flashLoanAmount,
            minShares,
            multicallExecutor,
            swapCalls
        );

        uint256 sharesAfter = leverageToken.balanceOf(address(this));
        sharesOut = sharesAfter - sharesBefore;

        // Underlying router enforces `minShares`, but keep the postcondition explicit.
        require(sharesOut >= minShares, "minShares");

        leverageToken.safeTransfer(receiver, sharesOut);

        // Optional hygiene: reset approval (prevents lingering approvals if this wrapper is re-used).
        collateralAsset.forceApprove(address(leverageRouter), 0);

        // Sweep any unexpected dust from the wrapper back to refundRecipient.
        // This keeps the wrapper stateless and avoids stranding tokens if the underlying router returns surplus debt.
        uint256 collateralDust = collateralAsset.balanceOf(address(this));
        if (collateralDust > 0) {
            collateralAsset.safeTransfer(refundRecipient, collateralDust);
        }

        uint256 debtDust = debtAsset.balanceOf(address(this));
        if (debtDust > 0) {
            debtAsset.safeTransfer(refundRecipient, debtDust);
        }
    }
}
```
