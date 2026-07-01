import 'server-only';
import type { NextRequest, NextResponse } from 'next/server';
import { isAddress, verifyMessage } from 'viem';
import { getD1 } from './cloudflare-env';
import { randomToken, sha256Hex } from './crypto';

export const SESSION_COOKIE = 'csma_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const NONCE_TTL_SECONDS = 5 * 60;

export interface AuthUser {
  id: string;
  walletAddress: `0x${string}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function normalizeAddress(address: string): `0x${string}` {
  if (!isAddress(address)) throw new Error('Invalid wallet address.');
  return address.toLowerCase() as `0x${string}`;
}

function buildSignInMessage(origin: string, walletAddress: `0x${string}`, nonce: string, issuedAt: string): string {
  return [
    'Cross-Session Memory Agent',
    '',
    'Sign in with your wallet to store your provider settings securely.',
    '',
    `Origin: ${origin}`,
    `Wallet: ${walletAddress}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

export async function createAuthChallenge(walletAddress: string, origin: string) {
  const db = await getD1();
  const address = normalizeAddress(walletAddress);
  const nonce = randomToken(24);
  const issuedAt = new Date().toISOString();
  const message = buildSignInMessage(origin, address, nonce, issuedAt);
  const createdAt = nowSeconds();
  const expiresAt = createdAt + NONCE_TTL_SECONDS;

  await db.prepare(`
    INSERT INTO auth_nonces (nonce, wallet_address, message, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(nonce, address, message, createdAt, expiresAt).run();

  return { walletAddress: address, nonce, message, expiresAt };
}

export async function verifyAuthChallenge(walletAddress: string, signature: `0x${string}`) {
  const db = await getD1();
  const address = normalizeAddress(walletAddress);
  const nonce = await db.prepare(`
    SELECT nonce, message
    FROM auth_nonces
    WHERE wallet_address = ? AND used_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(address, nowSeconds()).first<{ nonce: string; message: string }>();

  if (!nonce) throw new Error('No active sign-in challenge. Request a new nonce.');

  const valid = await verifyMessage({ address, message: nonce.message, signature });
  if (!valid) throw new Error('Wallet signature verification failed.');

  const timestamp = nowSeconds();
  await db.prepare('UPDATE auth_nonces SET used_at = ? WHERE nonce = ?').bind(timestamp, nonce.nonce).run();

  await db.prepare(`
    INSERT INTO users (wallet_address, created_at, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(wallet_address) DO UPDATE SET updated_at = excluded.updated_at
  `).bind(address, timestamp, timestamp).run();

  const user = await db.prepare('SELECT id, wallet_address AS walletAddress FROM users WHERE wallet_address = ?')
    .bind(address)
    .first<AuthUser>();
  if (!user) throw new Error('Failed to load authenticated user.');

  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  await db.prepare(`
    INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).bind(tokenHash, user.id, timestamp, timestamp + SESSION_TTL_SECONDS).run();

  return { user, token, maxAge: SESSION_TTL_SECONDS };
}

export async function getCurrentUser(req: NextRequest): Promise<AuthUser | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const db = await getD1();
  const tokenHash = await sha256Hex(token);
  return db.prepare(`
    SELECT users.id, users.wallet_address AS walletAddress
    FROM user_sessions
    JOIN users ON users.id = user_sessions.user_id
    WHERE user_sessions.token_hash = ? AND user_sessions.expires_at > ?
    LIMIT 1
  `).bind(tokenHash, nowSeconds()).first<AuthUser>();
}

export async function requireUser(req: NextRequest): Promise<AuthUser> {
  const user = await getCurrentUser(req);
  if (!user) throw new Error('Authentication required.');
  return user;
}

export async function destroyCurrentSession(req: NextRequest): Promise<void> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return;
  const db = await getD1();
  await db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}

export function setSessionCookie(res: NextResponse, token: string, maxAge: number): void {
  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set({
    name: SESSION_COOKIE,
    value: '',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}
