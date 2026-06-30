import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Synapse, calibration } from '@filoz/synapse-sdk';
import { fromSecp256k1, DefaultFwssPermissions, loginCall } from '@filoz/synapse-core/session-key';
import { encodeFunctionData,http } from 'viem';
import { config } from './config';

export interface LoginPreparation {
  to: `0x${string}`;
  data: `0x${string}`;
  sessionKeyAddress: `0x${string}`;
  suggestedValue: string;
}

export interface WalletSynapse {
  synapse: Synapse;
  walletAddress: `0x${string}`;
}

interface CachedSessionKey {
  privateKey: `0x${string}`;
  address: `0x${string}`;
  authorized: boolean;
  expiresAt: number;
  createdAt: number;
}

const CACHE_PATH = path.join(process.cwd(), '.session-keys.json');

function readCache(): Record<string, CachedSessionKey> {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')); } catch { return {}; }
}
function writeCache(cache: Record<string, CachedSessionKey>): void {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

function deriveSessionKey(userAddress: `0x${string}`): `0x${string}` {
  const hash = createHash('sha256')
    .update(config.sessionSecret + userAddress.toLowerCase())
    .digest('hex');
  return `0x${hash}` as `0x${string}`;
}

export function checkAuthorization(userAddress: `0x${string}`): boolean {
  const cache = readCache();
  const entry = cache[userAddress.toLowerCase()];
  if (!entry || !entry.authorized) return false;
  if (Date.now() > entry.expiresAt * 1000) return false;
  return true;
}

export async function prepareLoginTx(userAddress: `0x${string}`): Promise<LoginPreparation> {
  const { http } = await import('viem');
  const addr = userAddress.toLowerCase() as `0x${string}`;
  const cache = readCache();
  const existing = cache[addr];
  if (existing?.authorized) throw new Error('Session key already authorized');

  const sessionKeyPrivateKey = deriveSessionKey(addr);
  const sessionKey = fromSecp256k1({
    privateKey: sessionKeyPrivateKey, root: addr, chain: calibration,
    transport: http(),
  });
  const sessionKeyAddr = sessionKey.address as `0x${string}`;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = BigInt(now + 30 * 24 * 60 * 60);

  const loginTx = loginCall({
    address: sessionKeyAddr, permissions: DefaultFwssPermissions, expiresAt,
    origin: 'cross-session-memory-agent', chain: calibration,
  });
  const data = encodeFunctionData({
    abi: loginTx.abi, functionName: 'loginAndFund', args: loginTx.args,
  });

  cache[addr] = {
    privateKey: sessionKeyPrivateKey, address: sessionKeyAddr,
    authorized: false, expiresAt: Number(expiresAt), createdAt: Date.now(),
  };
  writeCache(cache);

  return {
    to: loginTx.address, data, sessionKeyAddress: sessionKeyAddr,
    suggestedValue: '0x' + (BigInt(10 ** 17)).toString(16),
  };
}

export async function confirmLogin(userAddress: `0x${string}`, txHash: `0x${string}`) {
  const { createPublicClient, http } = await import('viem');
  const addr = userAddress.toLowerCase() as `0x${string}`;
  const cache = readCache();
  if (!cache[addr]) return { authorized: false, error: 'No pending login' };

  const publicClient = createPublicClient({ chain: calibration, transport: http(config.filecoinRpcUrl) });
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    if (receipt.status === 'success') {
      cache[addr].authorized = true; writeCache(cache);
      return { authorized: true, blockNumber: receipt.blockNumber };
    }
    return { authorized: false, error: 'Transaction reverted' };
  } catch (err) {
    return { authorized: false, error: err instanceof Error ? err.message : 'Failed' };
  }
}

export async function createWalletSynapse(userAddress: `0x${string}`): Promise<WalletSynapse> {
  const { createClient, http } = await import('viem');
  const addr = userAddress.toLowerCase() as `0x${string}`;
  const cache = readCache();
  const entry = cache[addr];
  if (!entry?.authorized) throw new Error('Session key not authorized');

  const sessionKey = fromSecp256k1({
    privateKey: entry.privateKey, root: addr, chain: calibration,
    transport: http(config.filecoinRpcUrl),
  });

  const transport = http(config.filecoinRpcUrl);
  const client = createClient({ chain: calibration, account: addr, transport });
  const sessionClient = createClient({ chain: calibration, account: sessionKey.account, transport });
  const synapse = new Synapse({ client, sessionClient, source: config.synapseSource });

  return { synapse, walletAddress: addr };
}

export function getSessionKeyStatus(userAddress: `0x${string}`): {
  authorized: boolean; sessionKeyAddress?: string; expiresAt?: number;
} {
  const cache = readCache();
  const entry = cache[userAddress.toLowerCase()];
  if (!entry) return { authorized: false };
  return { authorized: entry.authorized, sessionKeyAddress: entry.address, expiresAt: entry.expiresAt };
}

export { calibration };
