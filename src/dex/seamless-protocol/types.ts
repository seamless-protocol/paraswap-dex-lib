import { Address } from '../../types';

// EventPool is intentionally not used (static-config driven markets).
export type PoolState = Record<string, never>;

// Minimal “data” carried from pricing -> tx building.
//
// IMPORTANT: getDexParam has no blockNumber, so any preview-derived values must be carried from getPricesVolume (which
// is block-pinned) into this struct.
export type SeamlessProtocolData = {
  leverageToken: Address;
  // The src amount this data was priced for (used for tx building).
  amountIn: bigint;
  // Expected output amount at pricing time (used for approval sizing fallback in tx building).
  amountOut: bigint;
  // Previewed debt (debtToken units) at the pricing block.
  // MUST correspond to amountIn (see doc: validate BigInt(srcAmount) == amountIn).
  flashLoanAmount: bigint;
};

export type SeamlessCore = {
  leverageManager: Address;
};

export type SeamlessPeriphery = {
  multicallExecutor: Address;
  // Gate 0 (optional): used only for swapCalls encoding validation.
  leverageRouter?: Address;
  // Gate 1 (required): ParaSwap venue call target (thin wrapper around LeverageRouter with explicit recipient + return value).
  dexLeverageRouter?: Address;
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

  // Feature flags control per-market side enablement.
  enableSellMint: boolean;
  enableSellRedeem?: boolean;
  enableBuyMint?: boolean;
  enableBuyRedeem?: boolean;
};

export type DexParams = {
  // Key MUST be lt.toLowerCase() for stable lookup/pool-id parsing.
  marketsByLeverageToken: Record<string, SeamlessMarketConfig>;
};
