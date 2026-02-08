import { Auction as AuctionContract } from 'generated';
import { AuctionABI } from './abi';
import { getClient, MPS, Q96, RESOLUTION, q96ToWei } from './utils';

function ac(address: string) {
  return { address: address as `0x${string}`, abi: AuctionABI } as const;
}

AuctionContract.TokensReceived.handler(async ({ event, context }) => {
  console.log(`[Auction] TokensReceived: ${event.srcAddress} totalSupply=${event.params.totalSupply}`);
  const addr = event.srcAddress.toLowerCase();
  const auction = await context.Auction.get(addr);
  if (!auction) return;
  context.Auction.set({ ...auction, totalSupply: event.params.totalSupply });
});

AuctionContract.AuctionStepRecorded.handler(async ({ event, context }) => {
  console.log(`[Auction] StepRecorded: ${event.srcAddress} mps=${event.params.mps} blocks=${event.params.startBlock}-${event.params.endBlock}`);
  const addr = event.srcAddress.toLowerCase();
  const auction = await context.Auction.get(addr);
  if (!auction) return;

  context.Auction.set({
    ...auction,
    currentStepMps: Number(event.params.mps),
    currentStepStartBlock: Number(event.params.startBlock),
    currentStepEndBlock: Number(event.params.endBlock),
    updatedAt: event.block.timestamp,
  });
});

AuctionContract.TickInitialized.handler(async ({ event, context }) => {
  const addr = event.srcAddress.toLowerCase();
  context.Tick.set({
    id: `${addr}:${event.params.price.toString()}`,
    auctionId: addr,
    priceQ96: event.params.price,
    nextPriceQ96: 0n,
    currencyDemand: 0n,
    numBids: 0,
  });
});

AuctionContract.BidSubmitted.handler(async ({ event, context }) => {
  console.log(`[Auction] BidSubmitted: ${event.srcAddress} id=${event.params.id} owner=${event.params.owner} amount=${event.params.amount} price=${event.params.price}`);
  const addr = event.srcAddress.toLowerCase();
  const auction = await context.Auction.get(addr);
  if (!auction) return;

  const bidId = `${addr}:${event.params.id.toString()}`;

  context.Bid.set({
    id: bidId,
    auctionId: addr,
    amount: event.params.amount,
    maxPriceQ96: event.params.price,
    owner: event.params.owner.toLowerCase(),
    tokensFilled: 0n,
    tokensClaimed: 0n,
    amountFilled: 0n,
    amountRefunded: 0n,
    exited: false,
    claimed: false,
    lastFullyFilledCheckpointBlock: event.block.number,
    startBlock: event.block.number,
    transactionHash: event.transaction.hash,
    outbidCheckpointBlock: undefined,
    exitedBlock: undefined,
    exitTransactionHash: undefined,
    claimedBlock: undefined,
    claimTransactionHash: undefined,
  });

  // Track bid ID on auction for checkpoint calculations
  const owners = new Set<string>();
  for (const id of auction.bidIds) {
    const b = await context.Bid.get(id);
    if (b) owners.add(b.owner);
  }
  owners.add(event.params.owner.toLowerCase());

  context.Auction.set({
    ...auction,
    numBids: auction.numBids + 1,
    totalBidAmount: auction.totalBidAmount + event.params.amount,
    numBidders: owners.size,
    bidIds: [...auction.bidIds, bidId],
    updatedAt: event.block.timestamp,
  });

  // Read tick state from contract
  if (context.isPreload) return;

  const client = getClient(event.chainId);
  try {
    const tickFromRPC = await client.readContract({
      ...ac(event.srcAddress),
      functionName: 'ticks',
      args: [event.params.price],
    });

    const tickId = `${addr}:${event.params.price.toString()}`;
    const existingTick = await context.Tick.get(tickId);

    context.Tick.set({
      id: tickId,
      auctionId: addr,
      priceQ96: event.params.price,
      nextPriceQ96: tickFromRPC.next,
      currencyDemand: q96ToWei(tickFromRPC.currencyDemandQ96),
      numBids: (existingTick?.numBids ?? 0) + 1,
    });
  } catch {
    // tick read failed
  }
});

AuctionContract.CheckpointUpdated.handler(async ({ event, context }) => {
  console.log(`[Auction] CheckpointUpdated: ${event.srcAddress} block=${event.params.blockNumber} clearingPrice=${event.params.clearingPrice} mps=${event.params.cumulativeMps}`);
  const addr = event.srcAddress.toLowerCase();
  const auction = await context.Auction.get(addr);
  if (!auction) return;

  if (context.isPreload) return;

  const client = getClient(event.chainId);
  const contract = ac(event.srcAddress);

  // Read checkpoint data from contract (event only has blockNumber, clearingPrice, cumulativeMps)
  let currencyRaisedAtClearingPriceQ96_X7 = 0n;
  let cumulativeMpsPerPrice = 0n;
  try {
    const checkpointFromRPC = await client.readContract({
      ...contract,
      functionName: 'checkpoints',
      args: [BigInt(event.params.blockNumber)],
    });
    currencyRaisedAtClearingPriceQ96_X7 = checkpointFromRPC.currencyRaisedAtClearingPriceQ96_X7;
    cumulativeMpsPerPrice = checkpointFromRPC.cumulativeMpsPerPrice;
  } catch (e) {
    console.warn(`[Auction] checkpoint read failed for ${addr}:`, (e as Error).message?.slice(0, 120));
  }

  const cp = {
    id: `${addr}:${event.params.blockNumber.toString()}`,
    auctionId: addr,
    blockNumber: Number(event.params.blockNumber),
    clearingPriceQ96: event.params.clearingPrice,
    currencyRaisedAtClearingPriceQ96_X7,
    cumulativeMps: Number(event.params.cumulativeMps),
    cumulativeMpsPerPrice,
  };

  context.Checkpoint.set(cp);

  // Read live totals
  let totalClearedFromRPC = auction.totalCleared;
  let currencyRaisedFromRPC = auction.currencyRaised;
  try {
    [totalClearedFromRPC, currencyRaisedFromRPC] = await Promise.all([
      client.readContract({ ...contract, functionName: 'totalCleared' }),
      client.readContract({ ...contract, functionName: 'currencyRaised' }),
    ]);
  } catch (e) {
    console.warn(`[Auction] totalCleared/currencyRaised read failed for ${addr}:`, (e as Error).message?.slice(0, 120));
  }

  const remainingMps = MPS - BigInt(cp.cumulativeMps);
  const availableSupply =
    remainingMps > 0n
      ? auction.totalSupply - auction.totalSupply / remainingMps
      : 0n;

  context.Auction.set({
    ...auction,
    cumulativeMps: cp.cumulativeMps,
    lastCheckpointedBlock: cp.blockNumber,
    lastClearingPriceQ96: cp.clearingPriceQ96,
    currencyRaised: currencyRaisedFromRPC,
    totalCleared: totalClearedFromRPC,
    remainingMps,
    availableSupply,
    updatedAt: event.block.timestamp,
  });

  // ---- Update bid fill state ----
  // Fetch all bids for this auction
  const allBids: NonNullable<Awaited<ReturnType<typeof context.Bid.get>>>[] = [];
  for (const bidId of auction.bidIds) {
    const bid = await context.Bid.get(bidId);
    if (bid) allBids.push(bid);
  }

  // Build checkpoint cache: map of blockNumber → checkpoint
  const cpBlocksNeeded = new Set<number>();
  for (const b of allBids) {
    cpBlocksNeeded.add(b.startBlock);
  }
  const cpMap = new Map<number, typeof cp>();
  // Current checkpoint
  cpMap.set(cp.blockNumber, cp);
  // Fetch historical checkpoints for bid start blocks
  for (const blockNum of cpBlocksNeeded) {
    if (cpMap.has(blockNum)) continue;
    const existing = await context.Checkpoint.get(`${addr}:${blockNum}`);
    if (existing) cpMap.set(blockNum, existing);
  }

  // Fully filled bids: maxPrice > clearingPrice, not exited
  const bidsFullyFilled = allBids.filter(
    (b) => b.maxPriceQ96 > cp.clearingPriceQ96 && !b.exited,
  );

  // Partially filled bids: maxPrice == clearingPrice, not exited, not outbid
  const bidsPartiallyFilled = allBids.filter(
    (b) =>
      b.maxPriceQ96 === cp.clearingPriceQ96 &&
      !b.exited &&
      b.outbidCheckpointBlock == null,
  );

  let tickDemandQ96FromRPC = 0n;
  if (bidsPartiallyFilled.length > 0) {
    try {
      const tickData = await client.readContract({
        ...contract,
        functionName: 'ticks',
        args: [cp.clearingPriceQ96],
      });
      tickDemandQ96FromRPC = tickData.currencyDemandQ96;
    } catch {
      // tick read failed
    }
  }

  // Calculate fills for fully filled bids
  for (const b of bidsFullyFilled) {
    const bidCp = cpMap.get(b.startBlock);
    if (!bidCp) continue;

    const mpsRemaining = MPS - BigInt(bidCp.cumulativeMps);
    if (mpsRemaining === 0n) continue;
    const cumulativeMpsDelta = BigInt(cp.cumulativeMps - bidCp.cumulativeMps);
    const cumulativeMpsPerPriceDelta = cp.cumulativeMpsPerPrice - bidCp.cumulativeMpsPerPrice;

    const tokensFilled =
      (b.amount * cumulativeMpsPerPriceDelta) / (Q96 * mpsRemaining);
    const amountFilled =
      tokensFilled !== 0n
        ? (b.amount * cumulativeMpsDelta) / mpsRemaining
        : 0n;

    context.Bid.set({
      ...b,
      tokensFilled,
      amountFilled,
      lastFullyFilledCheckpointBlock: cp.blockNumber,
    });
  }

  // Calculate fills for partially filled bids
  if (bidsPartiallyFilled.length > 0) {
    // Find last checkpoint before clearing price increased to current level
    let lastFullyCp: typeof cp | undefined;
    for (const [, c] of cpMap) {
      if (c.clearingPriceQ96 < cp.clearingPriceQ96) {
        if (!lastFullyCp || c.blockNumber > lastFullyCp.blockNumber) {
          lastFullyCp = c;
        }
      }
    }

    // If not found in cache, search all checkpoints for this auction
    if (!lastFullyCp) {
      for (const bidId of auction.bidIds) {
        const b = allBids.find((x) => x.id === bidId);
        if (!b) continue;
        const c = cpMap.get(b.startBlock);
        if (c && c.clearingPriceQ96 < cp.clearingPriceQ96) {
          if (!lastFullyCp || c.blockNumber > lastFullyCp.blockNumber) {
            lastFullyCp = c;
          }
        }
      }
    }

    if (lastFullyCp) {
      for (const b of bidsPartiallyFilled) {
        const bidCp = cpMap.get(b.startBlock);
        if (!bidCp) continue;

        const mpsRemaining = MPS - BigInt(bidCp.cumulativeMps);
        if (mpsRemaining === 0n) continue;
        const cumulativeMpsDelta = BigInt(lastFullyCp.cumulativeMps - bidCp.cumulativeMps);
        const cumulativeMpsPerPriceDelta =
          lastFullyCp.cumulativeMpsPerPrice - bidCp.cumulativeMpsPerPrice;

        let tokensFilled =
          (b.amount * cumulativeMpsPerPriceDelta) / (Q96 * mpsRemaining);
        let currencySpent =
          tokensFilled !== 0n
            ? (b.amount * cumulativeMpsDelta) / mpsRemaining
            : 0n;

        const denominator = tickDemandQ96FromRPC * mpsRemaining;
        if (denominator > 0n) {
          const partialCurrency =
            (b.amount * cp.currencyRaisedAtClearingPriceQ96_X7 + denominator - 1n) /
            denominator;
          const bidAmountQ96 = b.amount << RESOLUTION;
          const partialTokens =
            (bidAmountQ96 * cp.currencyRaisedAtClearingPriceQ96_X7) /
            denominator /
            b.maxPriceQ96;

          currencySpent += partialCurrency;
          tokensFilled += partialTokens;
        }

        context.Bid.set({
          ...b,
          tokensFilled,
          amountFilled: currencySpent,
        });
      }
    }
  }

  // Mark outbid bids
  for (const b of allBids) {
    if (b.maxPriceQ96 < cp.clearingPriceQ96 && b.outbidCheckpointBlock == null) {
      context.Bid.set({
        ...b,
        outbidCheckpointBlock: cp.blockNumber,
      });
    }
  }
});

AuctionContract.BidExited.handler(async ({ event, context }) => {
  console.log(`[Auction] BidExited: ${event.srcAddress} bidId=${event.params.bidId} refunded=${event.params.currencyRefunded}`);
  const addr = event.srcAddress.toLowerCase();
  const bidId = `${addr}:${event.params.bidId.toString()}`;

  const bid = await context.Bid.get(bidId);
  if (!bid) return;

  context.Bid.set({
    ...bid,
    exited: true,
    exitedBlock: event.block.number,
    exitTransactionHash: event.transaction.hash,
    tokensFilled: event.params.tokensFilled,
    amountRefunded: event.params.currencyRefunded,
  });

  const auction = await context.Auction.get(addr);
  if (auction) {
    context.Auction.set({
      ...auction,
      totalBidAmount: auction.totalBidAmount - event.params.currencyRefunded,
    });
  }
});

AuctionContract.TokensClaimed.handler(async ({ event, context }) => {
  console.log(`[Auction] TokensClaimed: ${event.srcAddress} bidId=${event.params.bidId} tokens=${event.params.tokensFilled}`);
  const addr = event.srcAddress.toLowerCase();
  const bidId = `${addr}:${event.params.bidId.toString()}`;

  const bid = await context.Bid.get(bidId);
  if (!bid) return;

  context.Bid.set({
    ...bid,
    claimed: true,
    claimedBlock: event.block.number,
    claimTransactionHash: event.transaction.hash,
    tokensClaimed: event.params.tokensFilled,
    tokensFilled: event.params.tokensFilled,
  });
});
