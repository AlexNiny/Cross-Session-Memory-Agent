import 'server-only';
import { allowUnsafeProviderUrls } from './cloudflare-env';

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) return true;

  if (/^127\./.test(host) || /^10\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host)) return true;

  const match172 = host.match(/^172\.(\d+)\./);
  if (match172) {
    const second = Number(match172[1]);
    if (second >= 16 && second <= 31) return true;
  }

  return false;
}

export async function normalizeProviderUrl(input: string): Promise<string> {
  const url = new URL(input.trim().replace(/\/+$/, '') || 'https://api.openai.com/v1');
  const unsafeAllowed = await allowUnsafeProviderUrls();

  if (!unsafeAllowed) {
    if (url.protocol !== 'https:') {
      throw new Error('Provider URL must use HTTPS in production.');
    }
    if (isPrivateHostname(url.hostname)) {
      throw new Error('Provider URL cannot target localhost or private network addresses.');
    }
  }

  return url.toString().replace(/\/+$/, '');
}
