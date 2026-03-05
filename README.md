# uniswap-cca-indexer

Indexes Uniswap's [Continuous Clearing Auction (CCA)](https://blog.uniswap.org/cca) contracts across Ethereum, Base, Arbitrum, and Unichain. Built with [Envio HyperIndex](https://docs.envio.dev/).

Tracks auctions, bids, ticks, steps, and checkpoints. Uses HyperSync for logs and selective RPC reads for derived on-chain state.

## Run locally

```bash
git clone git@github.com:dzmbs/uniswap-cca-indexer.git
cd uniswap-cca-indexer
pnpm install
```

Set up your environment:

```bash
cp .env.example .env
```

Edit `.env` and add your RPC URLs. Public fallbacks are baked in but they will get rate limited fast during backfill. Use private RPCs if you can (Alchemy, Infura, etc).

```env
ENVIO_API_TOKEN=        # required for HyperSync
ETH_RPC_URL=            # strongly recommended - private RPC
BASE_RPC_URL=
ARB_RPC_URL=
UNICHAIN_RPC_URL=
```

Start the indexer:

```bash
pnpm envio dev
```

GraphQL playground will be at `http://localhost:8080`.

## Rate limit tuning

The indexer makes RPC calls (eth_call) for on-chain state that isn't in event logs. Each call type has its own rate limit you can control via env vars:

```env
EFFECT_RPS_READ_TOTAL_SUPPLY=2
EFFECT_RPS_READ_AUCTION_SNAPSHOT=1
EFFECT_RPS_READ_STEPS=1
EFFECT_RPS_READ_CHECKPOINT_BUNDLE=6
EFFECT_RPS_READ_TICK_AT_BLOCK=3
EFFECT_RPS_READ_TICK_PAIR=6
```

These defaults are conservative for free-tier RPCs. If you're using a paid RPC, you can bump them up. If you're seeing 429s, lower `READ_CHECKPOINT_BUNDLE` and `READ_TICK_PAIR` first — those are the hottest paths.

## Aztec private sale

The Ethereum auction at `0x608c4e792C65f5527B3f70715deA44d3b302F4Ee` is the Aztec private token sale. It wasn't deployed through the canonical CCA factory, so it's registered directly in `config.yaml` as a static `Auction` address on chain 1. The handlers bootstrap its state from on-chain reads on first event.

## Project structure

```
src/
  handlers/
    CCAFactory.ts    # factory event processing, dynamic auction registration
    Auction.ts       # auction event processing, bid fill math
  utils/
    clients.ts       # per-chain RPC clients
    effects.ts       # rate-limited multicall reads
    math.ts          # CCA fill calculations
  abi.ts
config.yaml          # chain + contract config
schema.graphql       # data model
```
