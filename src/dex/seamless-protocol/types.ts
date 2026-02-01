import { Address } from '../../types';

// Phase 1: EventPool is intentionally not used.
export type PoolState = Record<string, never>;

// Minimal “data” carried from pricing -> tx building.
//
// IMPORTANT: getDexParam has no blockNumber, so any preview-derived values must be carried from getPricesVolume (which
// is block-pinned) into this struct.
export type SeamlessProtocolData = {
  leverageToken: Address;
  // The src amount this data was priced for (Phase 1: the full/chunked amount used for tx building).
  amountIn: bigint;
  // Previewed debt (debtToken units) at the pricing block.
  // MUST correspond to amountIn (see doc: validate BigInt(srcAmount) == amountIn).
  flashLoanAmount: bigint;
};

export type SeamlessCore = {
  leverageManager: Address;
  // Gate 1 (preferred for pricing): thin wrapper around leverage-tokens previews.
  // Optional until deployed/registered.
  // seamlessLtQuoter?: Address; // seamlessLtQuoter?: Address;
};

export type SeamlessPeriphery = {
  multicallExecutor: Address;
  // Gate 0 (optional): used only for swapCalls encoding validation.
  leverageRouter?: Address;
  // Gate 1 (required): ParaSwap venue call target.
  // leverageDexRouter?: Address;
};

export type SeamlessLeverageToken = {
  leverageToken: Address;
  collateralToken: Address;
  debtToken: Address;
};

export type SeamlessMarketConfig = {
  seamlessCore: SeamlessCore;
  seamlessPeriphery: SeamlessPeriphery;
  seamlessLeverageToken: SeamlessLeverageToken;

  // Feature flags let us keep Phase 1 intentionally narrow.
  enableSellMint: boolean;
  enableSellRedeem?: boolean;
};

export type DexParams = {
  // Key MUST be lt.toLowerCase() for stable lookup/pool-id parsing.
  marketsByLeverageToken: Record<string, SeamlessMarketConfig>;
};
