import { CCAFactory } from 'generated';
import { decodeAbiParameters } from 'viem';
import { AuctionABI } from './abi';
import { getClient } from './utils';

// Register auction contracts dynamically when CCAFactory emits AuctionCreated
const DEPLOYER = '0x4006c797fd3850473b7bec993a86a77fe7ab882d';

CCAFactory.AuctionCreated.contractRegister(({ event, context }) => {
  if (!isDeployer(event.params.configData)) return;
  console.log(`[Factory] Registering auction ${event.params.auction} chain=${event.chainId}`);
  context.addAuction(event.params.auction);
});

const CONFIG_COMPONENTS = [{ type: 'tuple', components: [
  { name: 'currency', type: 'address' },
  { name: 'tokensRecipient', type: 'address' },
  { name: 'fundsRecipient', type: 'address' },
  { name: 'startBlock', type: 'uint64' },
  { name: 'endBlock', type: 'uint64' },
  { name: 'claimBlock', type: 'uint64' },
  { name: 'tickSpacing', type: 'uint256' },
  { name: 'validationHook', type: 'address' },
  { name: 'floorPrice', type: 'uint256' },
  { name: 'requiredCurrencyRaised', type: 'uint128' },
  { name: 'auctionStepsData', type: 'bytes' },
]}] as const;

function isDeployer(configData: string): boolean {
  try {
    const [params] = decodeAbiParameters(CONFIG_COMPONENTS, configData as `0x${string}`);
    const r = params.fundsRecipient.toLowerCase();
    const t = params.tokensRecipient.toLowerCase();
    return r === DEPLOYER || t === DEPLOYER;
  } catch {
    return false;
  }
}

CCAFactory.AuctionCreated.handler(async ({ event, context }) => {
  if (!isDeployer(event.params.configData)) return;

  const addr = event.params.auction.toLowerCase();
  console.log(`[Factory] Processing auction ${addr} chain=${event.chainId} block=${event.block.number}`);

  let currency = '0x0000000000000000000000000000000000000000';
  let validationHook = '0x0000000000000000000000000000000000000000';
  let startBlock = 0;
  let endBlock = 0;
  let claimBlock = 0;
  let floorPrice = 0n;
  let tickSpacing = 0n;
  let requiredCurrencyRaised = 0n;

  try {
    const [params] = decodeAbiParameters(CONFIG_COMPONENTS, event.params.configData as `0x${string}`);
    currency = params.currency.toLowerCase();
    validationHook = params.validationHook.toLowerCase();
    startBlock = Number(params.startBlock);
    endBlock = Number(params.endBlock);
    claimBlock = Number(params.claimBlock);
    floorPrice = params.floorPrice;
    tickSpacing = params.tickSpacing;
    requiredCurrencyRaised = params.requiredCurrencyRaised;
  } catch {
    return;
  }

  context.Auction.set({
    id: addr,
    chainId: event.chainId,
    token: event.params.token.toLowerCase(),
    currency,
    amount: event.params.amount,
    startBlock,
    endBlock,
    claimBlock,
    totalSupply: 0n,
    floorPrice,
    tickSpacing,
    validationHook,
    requiredCurrencyRaised,
    createdAt: event.block.number,
    lastCheckpointedBlock: 0,
    lastClearingPriceQ96: 0n,
    currencyRaised: 0n,
    totalCleared: 0n,
    cumulativeMps: 0,
    remainingMps: 0n,
    availableSupply: 0n,
    currentStepMps: 0,
    currentStepStartBlock: 0,
    currentStepEndBlock: 0,
    numBids: 0,
    numBidders: 0,
    totalBidAmount: 0n,
    updatedAt: event.block.timestamp,
    bidIds: [],
  });

  if (context.isPreload) return;

  const client = getClient(event.chainId);
  const ac = { address: event.params.auction as `0x${string}`, abi: AuctionABI } as const;

  try {
    const totalSupply = await client.readContract({ ...ac, functionName: 'totalSupply' });
    if (totalSupply > 0n) {
      const auction = await context.Auction.get(addr);
      if (auction) context.Auction.set({ ...auction, totalSupply });
    }
    console.log(`[Factory] totalSupply=${totalSupply} for ${addr}`);
  } catch (e) {
    console.warn(`[Factory] totalSupply read failed for ${addr}:`, (e as Error).message?.slice(0, 100));
  }

  try {
    const pointer = await client.readContract({ ...ac, functionName: 'pointer' });
    const code = await client.getCode({ address: pointer });
    if (code && code.length > 4) {
      const data = code.slice(4);
      let stepStart = startBlock;
      let stepCount = 0;
      for (let i = 0; i < data.length; i += 16) {
        const chunk = data.slice(i, i + 16);
        if (chunk.length < 16) break;
        const mps = parseInt(chunk.slice(0, 6), 16);
        const blockDelta = parseInt(chunk.slice(6), 16);
        const stepEnd = stepStart + blockDelta;
        context.Step.set({ id: `${addr}:${i / 16}`, auctionId: addr, startBlock: stepStart, endBlock: stepEnd, mps });
        stepStart = stepEnd;
        stepCount++;
      }
      console.log(`[Factory] Parsed ${stepCount} steps for ${addr}`);
    }
  } catch (e) {
    console.warn(`[Factory] SSTORE2 read failed for ${addr}:`, (e as Error).message?.slice(0, 100));
  }
});
