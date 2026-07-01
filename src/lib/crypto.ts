import 'server-only';
import { getRequiredSecret } from './cloudflare-env';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function runtimeCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto is required for secret encryption.');
  }
  return globalThis.crypto;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importEncryptionKey(): Promise<CryptoKey> {
  const secret = await getRequiredSecret('APP_ENCRYPTION_KEY');
  const digest = await runtimeCrypto().subtle.digest('SHA-256', encoder.encode(secret));
  return runtimeCrypto().subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plaintext: string): Promise<string> {
  const iv = runtimeCrypto().getRandomValues(new Uint8Array(12));
  const key = await importEncryptionKey();
  const ciphertext = new Uint8Array(
    await runtimeCrypto().subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, encoder.encode(plaintext)),
  );
  return `v1:${toBase64Url(iv)}:${toBase64Url(ciphertext)}`;
}

export async function decryptSecret(payload: string): Promise<string> {
  const [version, iv, ciphertext] = payload.split(':');
  if (version !== 'v1' || !iv || !ciphertext) throw new Error('Unsupported encrypted secret format.');
  const key = await importEncryptionKey();
  const decrypted = await runtimeCrypto().subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(iv) as BufferSource },
    key,
    fromBase64Url(ciphertext) as BufferSource,
  );
  return decoder.decode(decrypted);
}

export function randomToken(bytes = 32): string {
  const data = runtimeCrypto().getRandomValues(new Uint8Array(bytes));
  return toBase64Url(data);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = new Uint8Array(await runtimeCrypto().subtle.digest('SHA-256', encoder.encode(input)));
  return Array.from(digest).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
