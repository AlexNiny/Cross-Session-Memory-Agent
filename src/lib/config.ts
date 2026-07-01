import 'server-only';

import { getCloudflareEnv } from './cloudflare-env';

type RuntimeConfigKey =
  | 'FILECOIN_PROVIDER_IDS'
  | 'FILECOIN_STORAGE_COPIES'
  | 'FILECOIN_RPC_URL'
  | 'FILECOIN_RPC_URLS'
  | 'SYNAPSE_SOURCE'
  | 'MEMORY_LIMIT';

async function getRuntimeConfigValue(name: RuntimeConfigKey): Promise<string | undefined> {
  try {
    const env = await getCloudflareEnv();
    const value = env[name];
    if (typeof value === 'string' && value.length > 0) return value;
  } catch {}

  const value = process.env[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseProviderIds(value: string | undefined): bigint[] {
  return (value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => BigInt(entry));
}

function parseStorageCopies(value: string | undefined): number {
  const parsed = Number(value || '2');
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 2;
}

export const config = {
  get filecoinRpcUrl() {
    return process.env.FILECOIN_RPC_URL || 'https://api.calibration.node.glif.io/rpc/v1';
  },
  get filecoinRpcUrls() {
    const configured = process.env.FILECOIN_RPC_URLS || process.env.FILECOIN_RPC_URL;
    if (configured) {
      return configured
        .split(',')
        .map((url) => url.trim())
        .filter(Boolean);
    }
    return [
      'https://api.calibration.node.glif.io/rpc/v1',
      'https://rpc.ankr.com/filecoin_testnet',
    ];
  },
  get synapseSource() {
    return process.env.SYNAPSE_SOURCE || 'cross-session-memory-agent';
  },
  get filecoinProviderIds() {
    return parseProviderIds(process.env.FILECOIN_PROVIDER_IDS);
  },
  get filecoinStorageCopies() {
    return parseStorageCopies(process.env.FILECOIN_STORAGE_COPIES);
  },
  get memoryLimit() {
    return parseInt(process.env.MEMORY_LIMIT || '10', 10);
  },
  get defaultProviderUrl() {
    return 'https://api.openai.com/v1';
  },
  get defaultModel() {
    return 'gpt-4o-mini';
  },
} as const;

export type AppConfig = typeof config;

export async function getFilecoinProviderIds(): Promise<bigint[]> {
  return parseProviderIds(await getRuntimeConfigValue('FILECOIN_PROVIDER_IDS'));
}

export async function getFilecoinStorageCopies(): Promise<number> {
  return parseStorageCopies(await getRuntimeConfigValue('FILECOIN_STORAGE_COPIES'));
}
