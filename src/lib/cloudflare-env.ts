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

export interface AppCloudflareEnv {
  DB?: D1Database;
  APP_ENCRYPTION_KEY?: string;
  SESSION_SECRET?: string;
  ALLOW_UNSAFE_PROVIDER_URLS?: string;
}

interface CloudflareExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface CloudflareContext {
  env?: AppCloudflareEnv;
  ctx?: CloudflareExecutionContext;
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
  };

  const context = await getCloudflareContextData();
  env = { ...env, ...(context.env || {}) };

  return env;
}

export async function scheduleBackgroundTask(label: string, promise: Promise<unknown>): Promise<void> {
  const guarded = promise.catch((err) => {
    console.error(`[CSMA-Background] ${label} failed:`, err);
  });
  const context = await getCloudflareContextData();
  if (context.ctx?.waitUntil) {
    context.ctx.waitUntil(guarded);
    return;
  }

  // Local Node fallback: keep the promise observed so failures do not become
  // unhandled rejections. Workers should use ctx.waitUntil above.
  void guarded;
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
