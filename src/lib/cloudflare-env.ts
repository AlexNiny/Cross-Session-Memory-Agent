import 'server-only';

export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta?: unknown;
  error?: string;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1Result>;
}

export interface QueueBinding<T = unknown> {
  send(message: T): Promise<void>;
}

export interface FilecoinBackupQueueMessage {
  kind: 'filecoin-backup';
  source: 'auto' | 'manual';
  sessionId: string;
  walletAddress: string;
  ownerId?: string;
  turns: Array<{
    turnIndex: number;
    userMessage: string;
    agentResponse: string;
    timestamp: number;
  }>;
}

export interface AppCloudflareEnv {
  DB?: D1Database;
  FILECOIN_BACKUP_QUEUE?: QueueBinding<FilecoinBackupQueueMessage>;
  APP_ENCRYPTION_KEY?: string;
  SESSION_SECRET?: string;
  ALLOW_UNSAFE_PROVIDER_URLS?: string;
  FILECOIN_PROVIDER_ID?: string;
  FILECOIN_PROVIDER_IDS?: string;
  FILECOIN_STORAGE_COPIES?: string;
  FILECOIN_RPC_URL?: string;
  FILECOIN_RPC_URLS?: string;
  SYNAPSE_SOURCE?: string;
  MEMORY_LIMIT?: string;
}

interface CloudflareContext {
  env?: AppCloudflareEnv;
}

async function getCloudflareContextData(): Promise<CloudflareContext> {
  try {
    const mod = await import('@opennextjs/cloudflare');
    try {
      return (mod.getCloudflareContext?.() || {}) as CloudflareContext;
    } catch {
      return (await mod.getCloudflareContext?.({ async: true }) || {}) as CloudflareContext;
    }
  } catch {
    return {};
  }
}

export async function getCloudflareEnv(): Promise<AppCloudflareEnv> {
  const processEnv: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {};
  let env: AppCloudflareEnv = {
    APP_ENCRYPTION_KEY: processEnv.APP_ENCRYPTION_KEY,
    SESSION_SECRET: processEnv.SESSION_SECRET,
    ALLOW_UNSAFE_PROVIDER_URLS: processEnv.ALLOW_UNSAFE_PROVIDER_URLS,
    FILECOIN_PROVIDER_ID: processEnv.FILECOIN_PROVIDER_ID,
    FILECOIN_PROVIDER_IDS: processEnv.FILECOIN_PROVIDER_IDS,
    FILECOIN_STORAGE_COPIES: processEnv.FILECOIN_STORAGE_COPIES,
    FILECOIN_RPC_URL: processEnv.FILECOIN_RPC_URL,
    FILECOIN_RPC_URLS: processEnv.FILECOIN_RPC_URLS,
    SYNAPSE_SOURCE: processEnv.SYNAPSE_SOURCE,
    MEMORY_LIMIT: processEnv.MEMORY_LIMIT,
  };

  const context = await getCloudflareContextData();
  env = { ...env, ...(context.env || {}) };

  return env;
}

export async function enqueueFilecoinBackup(message: FilecoinBackupQueueMessage): Promise<boolean> {
  const env = await getCloudflareEnv();
  if (!env.FILECOIN_BACKUP_QUEUE) return false;
  await env.FILECOIN_BACKUP_QUEUE.send(message);
  return true;
}

export async function getD1(): Promise<D1Database> {
  const env = await getCloudflareEnv();
  if (!env.DB) {
    throw new Error('Cloudflare D1 binding DB is not available. Run through OpenNext/Wrangler or configure the DB binding.');
  }
  return env.DB;
}

export async function getOptionalD1(): Promise<D1Database | null> {
  const env = await getCloudflareEnv();
  return env.DB || null;
}

export async function getRequiredSecret(name: keyof Pick<AppCloudflareEnv, 'APP_ENCRYPTION_KEY' | 'SESSION_SECRET'>): Promise<string> {
  const env = await getCloudflareEnv();
  const value = env[name];
  if (!value || value.length < 32) {
    throw new Error(`${name} must be configured as a strong secret of at least 32 characters.`);
  }
  return value;
}

export async function allowUnsafeProviderUrls(): Promise<boolean> {
  const env = await getCloudflareEnv();
  return env.ALLOW_UNSAFE_PROVIDER_URLS === 'true';
}
