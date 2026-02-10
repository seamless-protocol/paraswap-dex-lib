# Seamless Protocol

## Overview

Seamless Protocol is a DeFi lending/borrowing protocol.

The Seamless Leverage Token protocol is comprised of smart contracts that provide ERC20 tokenized representations of any leveraged position between 2 assets on a blockchain. If a lending market exists between 2 assets then a Leverage Token can be permissionlessly created for the leveraged position.

The primary primitive relevant to paraswap-dex-lib is the **Seamless Leverage Token (LT)**. Users can mint/redeem LT shares through Seamless periphery (flashloan + internal swaps +
manager accounting), and Paraswap can integrate that mint/redeem path as a DEX-like “venue” leg.

### Seamless and Velora(Paraswap)

Seamless are adding Markets for each leverage token. Each market will have the ability to support 4 swap legs.

- Swap Collateral Token to Leverage Token (Exact In)
- Swap Collateral Token to Leverage Token (Exact Out)
- Swap Leverage Token to Collateral Token (Exact In)
- Swap Leverage Token to Collateral Token (Exact Out)

Once these Swap Legs have been introduced Velora Users will be able to use the Paraswap API to execute swaps to and from any Seamless Leverage Token (and Collateral Token).
Including where the Leverage (or collateral token) may be used as an intermediate leg in a multi-leg swap.

Note: For the initial implementation Seamless will use **Velora Market API v6.2 → tx calldata → wrap as `IMulticallExecutor.Call[]`** for internal swaps. Moving forward this may be replaced with other intent based solving or direct DEX integrations.

#### Detailed Mapping of Supported Routes

The route is primarily determined by

- `srcToken` + `destToken` (mint vs redeem pair)
- `side` (SELL = ExactIn, BUY = ExactOut)
- `amount` (interpreted by side)

Which maps to

| Use case                  | API fields that select behavior    | amount meaning | Seamless quote path                                                                                                       | Swap                                                                                            | Flag                                        |
| ------------------------- | ---------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Collateral -> LT ExactIn  | src=collateral, dest=LT, side=SELL | collateral in  | LeverageRouter.previewDeposit                                                                                             | LeverageRouter.deposit (internally reaches LeverageManager.deposit)                             | enableSellMint                              |
| Collateral -> LT ExactOut | src=collateral, dest=LT, side=BUY  | LT out         | LeverageRouter.previewDeposit (quoteMintExactOut does binary search)                                                      | LeverageRouter.deposit (with minShares=destAmount)                                              | enableBuyMint (fallback enableSellMint)     |
| LT -> Collateral ExactIn  | src=LT, dest=collateral, side=SELL | LT in          | LeverageManager.previewRedeem (adjusted by the internal swap buffer (INTERNAL_SWAP_BUFFER_BPS) in seamless-protocol.ts)   | LeverageRouter.redeem (internally reaches LeverageManager.redeem)                               | enableSellRedeem                            |
| LT -> Collateral ExactOut | src=LT, dest=collateral, side=BUY  | collateral out | LeverageManager.previewWithdraw (adjusted by the internal swap buffer (INTERNAL_SWAP_BUFFER_BPS) in seamless-protocol.ts) | LeverageRouter.redeem (shares input solved from previewWithdraw, with minCollateral=destAmount) | enableBuyRedeem (fallback enableSellRedeem) |

Note: regarding ERC4626 shares vs ERC20 token units

- collateral in previewDeposit/previewMint/previewRedeem/previewWithdraw ActionData is in collateral-asset base units (token wei).
- shares is in LeverageToken share units (also the LT ERC20 base units).
- So in practice, “LeverageToken amount” = “shares amount”.

4-use-case walkthrough (short) Note LeverageRouter calls LeverageManager after the flashloan `function onMorphoFlashLoan`:

1. Collateral->LT ExactIn: quote shares via `LeverageRouter.previewDeposit`; execute `LeverageManager.deposit` called by `LeverageRouter.deposit`.
2. Collateral->LT ExactOut: solve collateral input via binary search on `LeverageRouter.previewDeposit`; execute `LeverageManager.deposit` called by `LeverageRouter.deposit`.
3. LT->Collateral ExactIn: quote collateral via `LeverageManager.previewRedeem`; execute `LeverageManager.redeem` called by `LeverageRouter.redeem`.
4. LT->Collateral ExactOut: quote required shares via `LeverageManager.previewWithdraw`; execute `LeverageManager.redeem` called by `LeverageRouter.redeem`.

Other fields are required for quote/tx building but do not change mint vs redeem logic:

- `network`, `version`, `srcDecimals`, `destDecimals`, `userAddress`, `receiver`, `slippage`
- Optional route controls: `includeDEXS`, `excludeDEXS`, `route`

LeverageManager has these 4 quote functions which are associated with (`deposit`, `mint`, `redeeem` and `withdraw`)

- `function previewDeposit(ILeverageToken token, uint256 collateral) external view returns (ActionData memory);`
  - Input is collateral amount in.
  - Output tells you how many shares you get (shares), plus implied debt.
  - “If I put in X collateral, what LT out?”
- `function previewMint(ILeverageToken token, uint256 shares) external view returns (ActionData memory);`
  - Input is target shares out.
  - Output tells you required collateral (collateral) and implied debt.
  - “If I want Y LT shares, how much collateral do I need?”
- `function previewRedeem(ILeverageToken token, uint256 shares) external view returns (ActionData memory);`
  - Input is shares in (burned).
  - Output tells you collateral out (collateral) and debt to repay (debt).
  - “If I burn X shares, how much collateral do I receive?”
- `function previewWithdraw(ILeverageToken token, uint256 collateral) external view returns (ActionData memory);`
  - Input is target collateral out.
  - Output tells you required shares in (shares) and debt to repay (debt).
  - “If I want Y collateral out, how many shares must I burn?”

## Design

### Assumptions

- Doing a reverse binary search for Collateral->LT ExactOut has acceptable performance, and we do not need to set it as false?
- Configuration for which Legs are supported is required at the Market (LeverageToken) level (i.e. we may have some leverage tokens which don't support a specific leg)
- Initial Supported Leverage Tokens are hardcoded in `config.ts`
- Future phase will involve having dynamic deployed LeverageToken support via an onchain registry (or possibly event driven).
- Static Price Population will be done initially using `getDexParam` (which will include an API call rather than an oracle lookup for the debt to collateral price for internal swaps
- Dynamic Price population will be done per quote request using `getPricesVolume` as this needs to be performant we will use an oracle lookup rather than an API call and accept there may be slippage implications.

### Defining Routes and Initializing Pool State

### Synchronizing Pool State

### Pricing and calculation of rates for token pairs and amounts

### Pricing and Quoting Functionality - Internal Collateral to Debt Swap Leg

#### Seamless use of Price Oracles for Collateral to Debt Token Pricing

Seamless Protocol Leverage Tokens rely on a lending market and the use of a lending Adapter for that Market.
The Market itself has a price Oracle which is used to retrieve prices between Debt and Collateral Tokens.
The example Leverage Token is based on a Morpho Market. However, the concept of lending markets having an asscociated price oracle is not Morpho specific.

Sample Contract Relationship

- Leverage Token
  - Collateral Token
  - Debt Token
  - Lending Adapter
    - `morphoMarketId`
    - `marketParams`
      - address `loanToken`;
      - address `collateralToken`;
      - address `oracle`; //This is the Oracle Address used by the Leverage Token
      - address `irm`;
      - uint256 `lltv`;

Sample Oracle call and value:

- `cast call 0xB22cd280b29e581e34423E86F65fd259F456D335 "convertCollateralToDebtAsset(uint256)(uint256)" 1000000000000000000 --rpc-url https://mainnet.gateway.tenderly.co/7GsNry3NUKrugHF3iat2rd`
- returns `1226709025305043763 wETH`
- `cast call 0xB22cd280b29e581e34423E86F65fd259F456D335 "convertDebtToCollateralAsset(uint256)(uint256)" 1227583834202275711 --block 24422367 --rpc-url https://mainnet.gateway.tenderly.co/7GsNry3NUKrugHF3iat2rd`
- returns `1000776459984034246 wstETH`

#### Use of Velora Market API (6.2) for Collateral to Debt Token Pricing

Slippage can occur as `previewDeposit` uses Adapter conversions which are oracle/state based (Aave/Morpho oracle math) and actual swaps use Paraswap pool routing.
The Oracle Price is used in quoting (for performance reasons) and the API price is used in execution to build the internal collateral to debt swap.

In the example below we see a higher price returned from the oracle. This would lead to slippage between the quote and execution price.

- Oracle Price: 1226709025305043763
- API Price : 1225269407591408937

- slippage = (API - Oracle) / Oracle
  - = (1225269407591408937 - 1226709025305043763) / 1226709025305043763
  - = -0.00117357 → -0.1174%

Sample Paraswap Price (Quote) Call for Internal Collateral to Debt Swap Leg
Following is a subset of the result payload for the complete payload see Appendix G: Sample API Request and Response

Example API call

```bash
  curl -sG "https://api.paraswap.io/prices" \
    --data-urlencode "network=1" \
    --data-urlencode "version=6.2" \
    --data-urlencode "side=SELL" \
    --data-urlencode "srcToken=0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" \
    --data-urlencode "srcDecimals=18" \
    --data-urlencode "destToken=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" \
    --data-urlencode "destDecimals=18" \
    --data-urlencode "amount=1000000000000000000"
```

Example API Result

```json
{
  "priceRoute": {
    "blockNumber": 24427317,
    "network": 1,
    "srcToken": "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
    "srcDecimals": 18,
    "srcAmount": "1000000000000000000",
    "destToken": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    "destDecimals": 18,
    "destAmount": "1225269407591408937"
  }
}
```

Slippage can occur as `previewDeposit` used Adapter conversions which are oracle/state based (Aave/Morpho oracle math) and actual swaps use Paraswap pool routing.

### Integrating with Augustus

### Signalling the most liquid tokens

## DEX Integration Walkthrough (5 Steps)

### Step 1/5: Initializing your DEX's pools state

### Step 2/5: Keeping your DEX's pools state in sync

### Step 3/5: Calculating your DEX's rates for a token pair and specific amount ranges

### Step 4/5: Allow Augustus to swap through your DEX

### Step 5/5: Signal the most liquid tokens of your DEX

#### Sample Swap Transaction Trace (Mint/Redeem, ExactIn, ExactOut)

### Signal the most liquid tokens of your DEX

### Recipient Handling and Intermediate Balances

### Exact Out calculation approaches

#### Existing Exact Out using `redeemWithVelora`

#### Alternate approach using Binary Search

### Alternate Solutions

#### Adding Recipient to LeverageRouter

#### Adding Quote Functionality to LeverageRouter

#### Using Tycho for Intermediate Legs

## Implementation

## Appendices

### Appendix A: sample swap requests (outer swap, not internal leg)

Use `USER=0x1111111111111111111111111111111111111111` for both `userAddress` and `receiver`.

### Appendix A: Collateral Token -> Levarage Token ExactIn (SELL)

Note: For a deposit, the user receives LeverageToken shares, not collateral tokens.

From:
(collateral=2000776459984034272, debt=1227583834202275711, shares=832089289353448791, tokenFee=0, treasuryFee=0)

- shares = 832089289353448791 is the LeverageToken amount received (with 18 decimals, 0.832089289353448791 LT).
- collateral = 2000776459984034272 is the total collateral used in the leveraged deposit (sender collateral + internally swapped collateral).
- debt = 1227583834202275711 is the debt borrowed/flash-loan sized to run the leverage.
- tokenFee, treasuryFee are share fees; here both are 0.

#### Environment setup

```bash
RPC="https://mainnet.gateway.tenderly.co/7GsNry3NUKrugHF3iat2rd"

# Seamless contracts
ROUTER="0xb0764dE7eeF0aC69855C431334B7BC51A96E6DbA"
MANAGER="0x5C37EB148D4a261ACD101e2B997A0F163Fb3E351"
MULTI="0x16D02Ebd89988cAd1Ce945807b963aB7A9Fd22E1"

# Tokens
COLLATERAL_TOKEN="0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0"   # wstETH
DEBT_TOKEN="0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"         # WETH
LT="0x10041DFFBE8fB54Ca4Dfa56F2286680EC98A37c3"                 # WSTETH-ETH-25x

# Augustus
AUG="0x6a000f20005980200259b80c5102003040001068"

# Example user for public Paraswap API calls
USER="0x1111111111111111111111111111111111111111"

# ExactIn input
COLLATERAL_IN="1000000000000000000"

# Keep these synced with previewDeposit output for the same COLLATERAL_IN
FLASH="1227564189645560052"
MIN_SHARES="832082628965646311"
```

#### Sample Paraswap IO quote request

- Outer quote request (Collateral -> LT ExactIn)
- Note: before SeamlessProtocol is listed on public Velora, this is expected to return "No routes found with enough liquidity".

Api call

```bash
  curl -sG "https://api.paraswap.io/prices" \
    --data-urlencode "network=1" \
    --data-urlencode "version=6.2" \
    --data-urlencode "side=SELL" \
    --data-urlencode "srcToken=0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" \
    --data-urlencode "srcDecimals=18" \
    --data-urlencode "destToken=0x10041DFFBE8fB54Ca4Dfa56F2286680EC98A37c3" \
    --data-urlencode "destDecimals=18" \
    --data-urlencode "amount=1000000000000000000"
```

Sample output

```json
{
  "network": 1,
  "version": "6.2",
  "side": "SELL",
  "srcToken": "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
  "srcDecimals": 18,
  "destToken": "0x10041DFFBE8fB54Ca4Dfa56F2286680EC98A37c3",
  "destDecimals": 18,
  "amount": "1000000000000000000"
}
```

#### Sample Seamless Protocol quote request

Cast command

```bash
  cast call \
    0xb0764dE7eeF0aC69855C431334B7BC51A96E6DbA \
    "previewDeposit(address,uint256)((uint256,uint256,uint256,uint256,uint256))" \
    0x10041DFFBE8fB54Ca4Dfa56F2286680EC98A37c3 \
    1000000000000000000 \
    --rpc-url https://mainnet.gateway.tenderly.co/7GsNry3NUKrugHF3iat2rd
```

sample json

```json
{
  "function": "LeverageRouter.previewDeposit",
  "target": "0xb0764dE7eeF0aC69855C431334B7BC51A96E6DbA",
  "signature": "previewDeposit(address,uint256)((uint256,uint256,uint256,uint256,uint256))",
  "input": {
    "ILeverageToken": "0x10041DFFBE8fB54Ca4Dfa56F2286680EC98A37c3",
    "collateralFromSender": "1000000000000000000"
  },
  "output": {
    "collateral": "2000760444939374916",
    "debt": "1227564189645560052",
    "shares": "832082628965646311",
    "tokenFee": "0",
    "treasuryFee": "0"
  }
}
```

#### Sample Paraswap IO swap request

Api call

```bash
  curl -sG "https://api.paraswap.io/swap" \
    --data-urlencode "network=1" \
    --data-urlencode "version=6.2" \
    --data-urlencode "side=SELL" \
    --data-urlencode "srcToken=0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" \
    --data-urlencode "srcDecimals=18" \
    --data-urlencode "destToken=0x10041DFFBE8fB54Ca4Dfa56F2286680EC98A37c3" \
    --data-urlencode "destDecimals=18" \
    --data-urlencode "amount=1000000000000000000" \
    --data-urlencode "userAddress=0x1111111111111111111111111111111111111111" \
    --data-urlencode "receiver=0x1111111111111111111111111111111111111111" \
    --data-urlencode "slippage=100"
```

#### Sample Seamless Internal Collateral Swap Request to paraswap.io

Api call

```bash
  INTERNAL_TX_DATA=$(curl -sG "https://api.paraswap.io/swap" \
    --data-urlencode "network=1" \
    --data-urlencode "version=6.2" \
    --data-urlencode "side=SELL" \
    --data-urlencode "srcToken=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" \
    --data-urlencode "srcDecimals=18" \
    --data-urlencode "destToken=0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" \
    --data-urlencode "destDecimals=18" \
    --data-urlencode "amount=${FLASH}" \
    --data-urlencode "userAddress=${MULTI}" \
    --data-urlencode "receiver=${MULTI}" \
    --data-urlencode "slippage=100" \
    --data-urlencode "excludeDEXS=Native,UniswapV4" | jq -r ".txParams.data")
```

Sample response fields (example snapshot):

```json
{
  "priceRoute": {
    "blockNumber": 24421820,
    "srcAmount": "1227564189645560052",
    "destAmount": "1001933313620991734"
  },
  "txParams": {
    "to": "0x6a000f20005980200259b80c5102003040001068",
    "value": "0",
    "data": "0xe3ead59e..."
  }
}
```

#### Sample Seamless swap request

Approvals needed

```bash
  APPROVE_ZERO=$(cast calldata "approve(address,uint256)" "$AUG" 0)
  APPROVE_FLASH=$(cast calldata "approve(address,uint256)" "$AUG" "$FLASH")
```

Cast Command

```bash
  cast calldata \
    "deposit(address,uint256,uint256,uint256,address,(address,uint256,bytes)[])" \
    "$LT" \
    1000000000000000000 \
    "$FLASH" \
    "$MIN_SHARES" \
    "$MULTI" \
    "[(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2,0,${APPROVE_ZERO}),(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2,0,${APPROVE_FLASH}),(0x6a000f20005980200259b80c5102003040001068,0,${INTERNAL_TX_DATA})]"
```

Sample json

```json
{
  "function": "LeverageRouter.deposit",
  "target": "0xb0764dE7eeF0aC69855C431334B7BC51A96E6DbA",
  "signature": "deposit(address,uint256,uint256,uint256,address,(address,uint256,bytes)[])",
  "input": {
    "leverageToken": "0x10041DFFBE8fB54Ca4Dfa56F2286680EC98A37c3",
    "collateralFromSender": "1000000000000000000",
    "flashLoanAmount": "1227564189645560052",
    "minShares": "832082628965646311",
    "multicallExecutor": "0x16D02Ebd89988cAd1Ce945807b963aB7A9Fd22E1",
    "swapCalls": [
      {
        "target": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "value": "0",
        "data": "approve(augustus, 0)"
      },
      {
        "target": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "value": "0",
        "data": "approve(augustus, 1227564189645560052)"
      },
      {
        "target": "0x6a000f20005980200259b80c5102003040001068",
        "value": "0",
        "data": "txParams.data from internal /swap"
      }
    ]
  },
  "output": {
    "returns": "none (nonpayable function)"
  }
}
```

### Appendix B: Collateral Token -> Leverage Token ExactOut (BUY)

```bash
  curl -sG "https://api.paraswap.io/swap" \
    --data-urlencode "network=1" \
    --data-urlencode "version=6.2" \
    --data-urlencode "side=BUY" \
    --data-urlencode "srcToken=0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" \
    --data-urlencode "srcDecimals=18" \
    --data-urlencode "destToken=0x10041DFFBE8fB54Ca4Dfa56F2286680EC98A37c3" \
    --data-urlencode "destDecimals=18" \
    --data-urlencode "amount=832000000000000000" \
    --data-urlencode "userAddress=0x1111111111111111111111111111111111111111" \
    --data-urlencode "receiver=0x1111111111111111111111111111111111111111" \
    --data-urlencode "slippage=100"
```

TODO: Populate other calls

### Appendix C: Leverage Token -> Collateral Token ExactIn (SELL)

```bash
  curl -sG "https://api.paraswap.io/swap" \
    --data-urlencode "network=1" \
    --data-urlencode "version=6.2" \
    --data-urlencode "side=SELL" \
    --data-urlencode "srcToken=0x10041DFFBE8fB54Ca4Dfa56F2286680EC98A37c3" \
    --data-urlencode "srcDecimals=18" \
    --data-urlencode "destToken=0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" \
    --data-urlencode "destDecimals=18" \
    --data-urlencode "amount=1000000000000000000" \
    --data-urlencode "userAddress=0x1111111111111111111111111111111111111111" \
    --data-urlencode "receiver=0x1111111111111111111111111111111111111111" \
    --data-urlencode "slippage=100"
```

TODO: Populate other calls

### Appendix D: Leverage Token -> Collateral Token ExactOut (BUY)

```bash
  curl -sG "https://api.paraswap.io/swap" \
    --data-urlencode "network=1" \
    --data-urlencode "version=6.2" \
    --data-urlencode "side=BUY" \
    --data-urlencode "srcToken=0x10041DFFBE8fB54Ca4Dfa56F2286680EC98A37c3" \
    --data-urlencode "srcDecimals=18" \
    --data-urlencode "destToken=0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" \
    --data-urlencode "destDecimals=18" \
    --data-urlencode "amount=1000000000000000000" \
    --data-urlencode "userAddress=0x1111111111111111111111111111111111111111" \
    --data-urlencode "receiver=0x1111111111111111111111111111111111111111" \
    --data-urlencode "slippage=100"
```

TODO: Populate other calls

## Appendix F - Use of Oracles in quoting

For example (previewDeposit(token, 1e18) returning collateral=2000776459984034272, debt=1227583834202275711, shares=832089289353448791), the oracle access path is:

1. LeverageRouter.previewDeposit
   ../leverage-tokens/src/periphery/LeverageRouter.sol:78 calls convertEquityToCollateral(token, collateralFromSender) at ../leverage-tokens/src/periphery/LeverageRouter.sol:83.
2. LeverageRouter.convertEquityToCollateral
   ../leverage-tokens/src/periphery/LeverageRouter.sol:53 reads:

- leverageManager.getLeverageTokenState(token) (:58)
- leverageManager.getLeverageTokenLendingAdapter(token) (:59)
- leverageManager.BASE_RATIO() (:60)

3. LeverageManager.getLeverageTokenState
   ../leverage-tokens/src/LeverageManager.sol:282 calls \_getLeverageTokenState(getLeverageTokenLendingAdapter(token)).
4. \_getLeverageTokenState pulls adapter state
   ../leverage-tokens/src/LeverageManager.sol:764:

- lendingAdapter.getCollateralInDebtAsset() (:769)
- lendingAdapter.getDebt() (:770)
- lendingAdapter.getEquityInDebtAsset() (:771)
- computes collateralRatio = collateralInDebtAsset \* BASE_RATIO / debt (:773-774)

5. Oracle is hit inside Morpho adapter conversion
   ../leverage-tokens/src/lending/MorphoLendingAdapter.sol:131 -> getCollateralInDebtAsset() -> convertCollateralToDebtAsset(getCollateral())
   ../leverage-tokens/src/lending/MorphoLendingAdapter.sol:106 -> IOracle(marketParams.oracle).price() at :109.
6. Concrete oracle for this market
   Adapter (0xB22cd280...) has marketParams.oracle = 0xbD60A6770b27E084E8617335ddE769241B0e71D8.
   At block 24422367, price() returned 1226631404001908485000000000000000000 (~1.2266e36 scale).
7. Back in router conversion, branch used for your state
   Since adapter getCollateral()!=0 and getDebt()!=0, it uses
   mulDiv(equity, collateralRatio, collateralRatio-baseRatio, Ceil) at ../leverage-tokens/src/periphery/LeverageRouter.sol:70-71, giving collateral = 2000776459984034272.
8. Then manager preview is called with that collateral
   ../leverage-tokens/src/periphery/LeverageRouter.sol:84 -> leverageManager.previewDeposit(token, collateral)
   ../leverage-tokens/src/LeverageManager.sol:323 computes:

- debt via \_convertCollateralToDebt (:327, formula at :602)
- shares via \_convertCollateralToShares (:336, formula at :650)
  Result: debt=1227583834202275711, shares=832089289353448791.

Appendix G: Sample API Request and Response

Sample Request

```bash
  curl -sG "https://api.paraswap.io/prices" \
    --data-urlencode "network=1" \
    --data-urlencode "version=6.2" \
    --data-urlencode "side=SELL" \
    --data-urlencode "srcToken=0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" \
    --data-urlencode "srcDecimals=18" \
    --data-urlencode "destToken=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" \
    --data-urlencode "destDecimals=18" \
    --data-urlencode "amount=1000000000000000000"
```

Sample Response

```json
{
  "priceRoute": {
    "blockNumber": 24427701,
    "network": 1,
    "srcToken": "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
    "srcDecimals": 18,
    "srcAmount": "1000000000000000000",
    "destToken": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    "destDecimals": 18,
    "destAmount": "1225321457601530719",
    "bestRoute": [
      {
        "percent": 100,
        "swaps": [
          {
            "srcToken": "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
            "srcDecimals": 18,
            "destToken": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
            "destDecimals": 18,
            "swapExchanges": [
              {
                "exchange": "BalancerV3",
                "srcAmount": "1000000000000000000",
                "destAmount": "1225321457601530719",
                "percent": 100,
                "poolAddresses": ["0x6b31a94029fd7840d780191b6d63fa0d269bd883"],
                "poolIdentifiers": [
                  "0x6b31a94029fd7840d780191b6d63fa0d269bd883"
                ],
                "data": {
                  "steps": [
                    {
                      "pool": "0x2411802d8bea09be0af8fd8d08314a63e706b29c",
                      "isBuffer": true,
                      "swapInput": {
                        "tokenIn": "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
                        "tokenOut": "0x2411802d8bea09be0af8fd8d08314a63e706b29c"
                      },
                      "poolState": {
                        "poolType": "Buffer",
                        "rate": "1038061261361000000",
                        "poolAddress": "0x2411802d8bea09be0af8fd8d08314a63e706b29c",
                        "tokens": [
                          "0x2411802d8bea09be0af8fd8d08314a63e706b29c",
                          "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0"
                        ],
                        "maxDeposit": "170141183460469147948298304428793086681",
                        "maxMint": "163902834826335191190600937384355534952"
                      }
                    },
                    {
                      "pool": "0x6b31a94029fd7840d780191b6d63fa0d269bd883",
                      "isBuffer": false,
                      "swapInput": {
                        "tokenIn": "0x2411802d8bea09be0af8fd8d08314a63e706b29c",
                        "tokenOut": "0x90551c1795392094fe6d29b758eccd233cfaa260"
                      },
                      "poolState": {
                        "poolAddress": "0x6b31a94029fd7840d780191b6d63fa0d269bd883",
                        "version": 1,
                        "tokens": [
                          "0x2411802d8bea09be0af8fd8d08314a63e706b29c",
                          "0x90551c1795392094fe6d29b758eccd233cfaa260"
                        ],
                        "tokensUnderlying": [
                          "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
                          "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
                        ],
                        "weights": ["0", "0"],
                        "poolType": "STABLE",
                        "hookAddress": "0xb18fa0cb5de8cecb8899aae6e38b1b7ed77885da",
                        "hookType": "StableSurge",
                        "supportsUnbalancedLiquidity": true,
                        "paramsAlpha": "0",
                        "paramsBeta": "0",
                        "paramsC": "0",
                        "paramsS": "0",
                        "paramsLambda": "0",
                        "tauAlphaX": "0",
                        "tauAlphaY": "0",
                        "tauBetaX": "0",
                        "tauBetaY": "0",
                        "u": "0",
                        "v": "0",
                        "w": "0",
                        "z": "0",
                        "dSq": "0",
                        "tokenRates": [
                          "1273399118131076596",
                          "1068145992510000000"
                        ],
                        "balancesLiveScaled18": [
                          "2270915530340569528849",
                          "1040252909978996322009"
                        ],
                        "swapFee": "20000000000000",
                        "aggregateSwapFee": "500000000000000000",
                        "totalSupply": "3238281579670185089070",
                        "scalingFactors": ["1", "1"],
                        "isPoolPaused": false,
                        "amp": "900000",
                        "ampIsUpdating": false,
                        "ampStartValue": "700000",
                        "ampEndValue": "900000",
                        "ampStartTime": "1769008895",
                        "ampStopTime": "1769212800",
                        "erc4626Rates": [
                          "1038061261361000000",
                          "1068145992510000000"
                        ],
                        "erc4626MaxDeposit": [
                          "170141183460469147948298304428793086681",
                          "170141183460469130573690143185856676150"
                        ],
                        "erc4626MaxMint": [
                          "163902834826335191190600937384355534952",
                          "159286450217034602666001948379913672396"
                        ]
                      }
                    },
                    {
                      "pool": "0x90551c1795392094fe6d29b758eccd233cfaa260",
                      "isBuffer": true,
                      "swapInput": {
                        "tokenIn": "0x90551c1795392094fe6d29b758eccd233cfaa260",
                        "tokenOut": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
                      },
                      "poolState": {
                        "poolType": "Buffer",
                        "rate": "1068145992510000000",
                        "poolAddress": "0x90551c1795392094fe6d29b758eccd233cfaa260",
                        "tokens": [
                          "0x90551c1795392094fe6d29b758eccd233cfaa260",
                          "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
                        ],
                        "maxDeposit": "170141183460469130573690143185856676150",
                        "maxMint": "159286450217034602666001948379913672396"
                      }
                    }
                  ],
                  "gasUSD": "0.130810"
                }
              }
            ]
          }
        ]
      }
    ],
    "gasCostUSD": "0.153334",
    "gasCost": "331810",
    "side": "SELL",
    "version": "6.2",
    "contractAddress": "0x6a000f20005980200259b80c5102003040001068",
    "tokenTransferProxy": "0x6a000f20005980200259b80c5102003040001068",
    "contractMethod": "swapExactAmountIn",
    "partnerFee": 0.01,
    "srcUSD": "2485.2000000000",
    "destUSD": "2478.5802444364",
    "partner": "anon",
    "maxImpactReached": false,
    "hmac": "c084f151d999fc3c50d0ef6c1262815486a4f4c7"
  }
}
```
