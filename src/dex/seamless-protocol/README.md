# Seamless Protocol

## Testing

```bash
# All integration tests
yarn test-integration seamless-protocol

# Each Individual Test File
yarn test src/dex/seamless-protocol/seamless-protocol-integration.test.ts
yarn test src/dex/seamless-protocol/seamless-protocol-e2e.test.ts
yarn test src/dex/seamless-protocol/seamless-protocol-events.test.ts

# Each Individual Test by files
## src/dex/seamless-protocol/seamless-protocol-integration.test.ts
yarn test src/dex/seamless-protocol/seamless-protocol-integration.test.ts -t 'getPoolIdentifiers and getPricesVolume SELL'
yarn test src/dex/seamless-protocol/seamless-protocol-integration.test.ts -t 'getPoolIdentifiers and getPricesVolume BUY'
yarn test src/dex/seamless-protocol/seamless-protocol-integration.test.ts -t 'getTopPoolsForToken'

## src/dex/seamless-protocol/seamless-protocol-e2e.test.ts
# NOTE: This is still template-scaffolded (tokenASymbol/tokenBSymbol are placeholders).
# Run the whole suite (or update the template tokens first).
yarn test src/dex/seamless-protocol/seamless-protocol-e2e.test.ts -t 'SeamlessProtocol E2E'


## seamless-protocol-events.test.ts
# Phase 1: EventPool is intentionally disabled; this test is a scaffold/no-op.
yarn test src/dex/seamless-protocol/seamless-protocol-events.test.ts

```
