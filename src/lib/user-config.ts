import 'server-only';
import { getD1 } from './cloudflare-env';
import { decryptSecret, encryptSecret } from './crypto';
import { normalizeProviderUrl } from './provider-url';

export interface StoredLLMConfig {
  providerUrl: string;
  model: string;
  hasApiKey: boolean;
}

export interface ResolvedLLMConfig {
  providerUrl: string;
  model: string;
  apiKey: string;
}

export async function getStoredLLMConfig(userId: string): Promise<StoredLLMConfig | null> {
  const db = await getD1();
  const row = await db.prepare(`
    SELECT provider_url AS providerUrl, model, encrypted_api_key AS encryptedApiKey
    FROM user_llm_configs
    WHERE user_id = ?
  `).bind(userId).first<{ providerUrl: string; model: string; encryptedApiKey: string | null }>();
  if (!row) return null;
  return {
    providerUrl: row.providerUrl,
    model: row.model,
    hasApiKey: Boolean(row.encryptedApiKey),
  };
}

export async function getResolvedLLMConfig(userId: string): Promise<ResolvedLLMConfig> {
  const db = await getD1();
  const row = await db.prepare(`
    SELECT provider_url AS providerUrl, model, encrypted_api_key AS encryptedApiKey
    FROM user_llm_configs
    WHERE user_id = ?
  `).bind(userId).first<{ providerUrl: string; model: string; encryptedApiKey: string | null }>();

  if (!row?.encryptedApiKey) throw new Error('Configure your provider API key first.');
  return {
    providerUrl: row.providerUrl,
    model: row.model,
    apiKey: await decryptSecret(row.encryptedApiKey),
  };
}

export async function upsertLLMConfig(
  userId: string,
  input: { providerUrl: string; model: string; apiKey?: string },
): Promise<StoredLLMConfig> {
  const db = await getD1();
  const providerUrl = await normalizeProviderUrl(input.providerUrl || 'https://api.openai.com/v1');
  const model = (input.model || 'gpt-4o-mini').trim();
  if (!model) throw new Error('Model is required.');

  const existing = await db.prepare('SELECT encrypted_api_key AS encryptedApiKey FROM user_llm_configs WHERE user_id = ?')
    .bind(userId)
    .first<{ encryptedApiKey: string | null }>();
  const encryptedApiKey = input.apiKey && input.apiKey.trim().length > 0
    ? await encryptSecret(input.apiKey.trim())
    : existing?.encryptedApiKey || null;
  const timestamp = Math.floor(Date.now() / 1000);

  await db.prepare(`
    INSERT INTO user_llm_configs (user_id, provider_url, model, encrypted_api_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      provider_url = excluded.provider_url,
      model = excluded.model,
      encrypted_api_key = excluded.encrypted_api_key,
      updated_at = excluded.updated_at
  `).bind(userId, providerUrl, model, encryptedApiKey, timestamp, timestamp).run();

  return { providerUrl, model, hasApiKey: Boolean(encryptedApiKey) };
}
