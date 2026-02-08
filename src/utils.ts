import { createPublicClient, http, type PublicClient } from 'viem';
import { base, arbitrum } from 'viem/chains';

export const MPS = 10000000n; // 1e7
export const Q96 = 0x1000000000000000000000000n; // 2^96
export const RESOLUTION = 96n;

export function q96ToWei(valueQ96: bigint): bigint {
  return valueQ96 >> 96n;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clients = new Map<number, any>();

export function getClient(chainId: number): PublicClient {
  let client = clients.get(chainId);
  if (client) return client;

  switch (chainId) {
    case 8453:
      client = createPublicClient({
        chain: base,
        transport: http(process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/gCiC--s3GAbWDFvwTohqN'),
        batch: { multicall: true },
      });
      break;
    case 42161:
      client = createPublicClient({
        chain: arbitrum,
        transport: http(process.env.ARB_RPC_URL || 'https://arb-mainnet.g.alchemy.com/v2/gCiC--s3GAbWDFvwTohqN'),
        batch: { multicall: true },
      });
      break;
    default:
      throw new Error(`Unsupported chain: ${chainId}`);
  }

  clients.set(chainId, client);
  return client as PublicClient;
}
