import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Synapse, calibration } from '@filoz/synapse-sdk';
import { fromSecp256k1, DefaultFwssPermissions, loginCall } from '@filoz/synapse-core/session-key';
import { encodeFunctionData, erc20Abi, fallback, formatEther, http, isAddressEqual, parseEventLogs } from 'viem';
import { getBalance, waitForTransactionReceipt } from 'viem/actions';
import { config } from './config';

export interface LoginPreparation {
  to: `0x${string}`;
  data: `0x${string}`;
  sessionKeyAddress: `0x${string}`;
  suggestedValue?: string;
}

export interface WalletSynapse {
  synapse: Synapse;
  walletAddress: `0x${string}`;
}

export interface StorageFundingStatus {
  storageAccount: `0x${string}`;
  tfilBalance: string;
  walletUsdfcBalance: string;
  paymentUsdfcBalance: string;
  filecoinPayAllowance: string;
  tfilBalanceRaw: string;
  walletUsdfcBalanceRaw: string;
  paymentUsdfcBalanceRaw: string;
  filecoinPayAllowanceRaw: string;
  fwssApproved: boolean;
  fwssRateAllowance: string;
  fwssLockupAllowance: string;
  fwssMaxLockupPeriod: string;
  usdfcTokenAddress: `0x${string}`;
  filecoinPayAddress: `0x${string}`;
  warmStorageAddress: `0x${string}`;
}

export interface DepositUsdfcResult {
  storageAccount: `0x${string}`;
  amount: string;
  transferHash?: `0x${string}`;
  approvalHash?: `0x${string}`;
  depositHash?: `0x${string}`;
  serviceApprovalHash?: `0x${string}`;
  before: StorageFundingStatus;
  after: StorageFundingStatus;
}

export interface WarmStorageApprovalResult {
  storageAccount: `0x${string}`;
  serviceApprovalHash?: `0x${string}`;
  before: StorageFundingStatus;
  after: StorageFundingStatus;
}

export interface ExistingUsdfcDepositResult {
  storageAccount: `0x${string}`;
  amount: string;
  approvalHash?: `0x${string}`;
  depositHash: `0x${string}`;
  before: StorageFundingStatus;
  after: StorageFundingStatus;
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

function isPrivateKey(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isEncryptedSecret(value: string): boolean {
  return value.startsWith('v1:');
}

async function decryptStoredPrivateKey(value: string): Promise<`0x${string}`> {
  if (isEncryptedSecret(value)) {
    const { decryptSecret } = await import('./crypto');
    const decrypted = await decryptSecret(value);
    if (!isPrivateKey(decrypted)) throw new Error('Stored Filecoin session key is invalid.');
    return decrypted;
  }
  if (!isPrivateKey(value)) throw new Error('Stored Filecoin session key is invalid.');
  return value;
}

async function encryptStoredPrivateKey(value: `0x${string}`): Promise<string> {
  const { encryptSecret } = await import('./crypto');
  return encryptSecret(value);
}

async function getCacheEntry(userAddress: `0x${string}`): Promise<CachedSessionKey | null> {
  const addr = userAddress.toLowerCase() as `0x${string}`;
  const { getOptionalD1 } = await import('./cloudflare-env');
  const db = await getOptionalD1();
  if (db) {
    const row = await db.prepare(`
      SELECT private_key AS privateKey, session_key_address AS address, authorized, expires_at AS expiresAt, created_at AS createdAt
      FROM filecoin_session_keys
      WHERE wallet_address = ?
    `).bind(addr).first<{
      privateKey: string;
      address: `0x${string}`;
      authorized: number;
      expiresAt: number;
      createdAt: number;
    }>();
    if (!row) return null;
    const privateKey = await decryptStoredPrivateKey(row.privateKey);
    const entry = {
      privateKey,
      address: row.address,
      authorized: Boolean(row.authorized),
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
    if (!isEncryptedSecret(row.privateKey)) {
      await setCacheEntry(addr, entry);
    }
    return entry;
  }

  return readCache()[addr] || null;
}

async function setCacheEntry(userAddress: `0x${string}`, entry: CachedSessionKey): Promise<void> {
  const addr = userAddress.toLowerCase() as `0x${string}`;
  const { getOptionalD1 } = await import('./cloudflare-env');
  const db = await getOptionalD1();
  if (db) {
    await db.prepare(`
      INSERT INTO filecoin_session_keys (
        wallet_address, private_key, session_key_address, authorized, expires_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet_address) DO UPDATE SET
        private_key = excluded.private_key,
        session_key_address = excluded.session_key_address,
        authorized = excluded.authorized,
        expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
    `).bind(
      addr,
      await encryptStoredPrivateKey(entry.privateKey),
      entry.address,
      entry.authorized ? 1 : 0,
      entry.expiresAt,
      entry.createdAt,
      Math.floor(Date.now() / 1000),
    ).run();
    return;
  }

  const cache = readCache();
  cache[addr] = entry;
  writeCache(cache);
}

async function deriveSessionKey(userAddress: `0x${string}`): Promise<`0x${string}`> {
  const { getRequiredSecret } = await import('./cloudflare-env');
  const sessionSecret = await getRequiredSecret('SESSION_SECRET');
  const hash = createHash('sha256')
    .update(sessionSecret + userAddress.toLowerCase())
    .digest('hex');
  return `0x${hash}` as `0x${string}`;
}

export async function checkAuthorization(userAddress: `0x${string}`): Promise<boolean> {
  const entry = await getCacheEntry(userAddress);
  if (!entry || !entry.authorized) return false;
  if (Date.now() > entry.expiresAt * 1000) return false;
  return true;
}

export async function prepareLoginTx(userAddress: `0x${string}`): Promise<LoginPreparation> {
  const { http } = await import('viem');
  const addr = userAddress.toLowerCase() as `0x${string}`;
  const existing = await getCacheEntry(addr);
  if (existing?.authorized) throw new Error('Session key already authorized');

  const sessionKeyPrivateKey = await deriveSessionKey(addr);
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

  await setCacheEntry(addr, {
    privateKey: sessionKeyPrivateKey, address: sessionKeyAddr,
    authorized: false, expiresAt: Number(expiresAt), createdAt: Date.now(),
  });

  return {
    to: loginTx.address, data, sessionKeyAddress: sessionKeyAddr,
    suggestedValue: '0x' + (BigInt('1000000000000000000')).toString(16),  // 1 tFIL
  };
}

export async function confirmLogin(userAddress: `0x${string}`, txHash: `0x${string}`) {
  const { createPublicClient } = await import('viem');
  const { getTransactionReceipt } = await import('viem/actions');
  const addr = userAddress.toLowerCase() as `0x${string}`;
  const entry = await getCacheEntry(addr);
  if (!entry) return { authorized: false, error: 'No pending login' };

  const publicClient = createPublicClient({ chain: calibration, transport: createFilecoinTransport() });
  try {
    const receipt = await getTransactionReceipt(publicClient, { hash: txHash });
    if (receipt.status === 'success') {
      await setCacheEntry(addr, { ...entry, authorized: true });
      return { authorized: true, blockNumber: receipt.blockNumber };
    }
    return { authorized: false, error: 'Transaction reverted' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found|could not find|not be found|transaction receipt/i.test(message)) {
      return { authorized: false, pending: true, txHash };
    }
    return { authorized: false, error: err instanceof Error ? err.message : 'Failed' };
  }
}

export async function createWalletSynapse(userAddress: `0x${string}`): Promise<WalletSynapse> {
  const { createClient } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const addr = userAddress.toLowerCase() as `0x${string}`;
  const entry = await getCacheEntry(addr);
  if (!entry?.authorized) throw new Error('Session key not authorized');

  // Create session key
  const sessionKey = fromSecp256k1({
    privateKey: entry.privateKey as `0x${string}`,
    root: addr,
    chain: calibration,
  });

  // Docs: MUST syncExpirations() before using session key
  await sessionKey.syncExpirations();

  // client needs a LOCAL account (with private key) so signing works locally.
  // Using a plain address string creates a JSON-RPC account that proxies
  // signing to the RPC endpoint — public RPCs don't support eth_signTypedData_v4.
  const transport = createFilecoinTransport();
  const storageAccount = privateKeyToAccount(entry.privateKey as `0x${string}`);
  const client = createClient({ chain: calibration, account: storageAccount, transport });
  const synapse = new Synapse({
    client,
    sessionClient: sessionKey.client,
    source: config.synapseSource,
  });

  return { synapse, walletAddress: addr };
}

function createFilecoinTransport() {
  return fallback(config.filecoinRpcUrls.map((url) => http(url)), {
    retryCount: 2,
    retryDelay: 500,
  });
}

export async function getStorageFundingStatus(userAddress: `0x${string}`): Promise<StorageFundingStatus> {
  const { synapse } = await createWalletSynapse(userAddress);
  const storageAccount = synapse.client.account.address as `0x${string}`;
  const chain = synapse.chain;

  const [tfilBalance, walletUsdfcBalance, paymentUsdfcBalance, filecoinPayAllowance, fwssApproval] =
    await Promise.all([
      getBalance(synapse.client, { address: storageAccount }),
      synapse.payments.walletBalance({ token: 'USDFC' as any }),
      synapse.payments.balance(),
      synapse.payments.allowance({ spender: chain.contracts.filecoinPay.address }),
      synapse.payments.serviceApproval({ service: chain.contracts.fwss.address }),
    ]);

  return {
    storageAccount,
    tfilBalance: formatEther(tfilBalance),
    walletUsdfcBalance: formatEther(walletUsdfcBalance),
    paymentUsdfcBalance: formatEther(paymentUsdfcBalance),
    filecoinPayAllowance: formatEther(filecoinPayAllowance),
    tfilBalanceRaw: tfilBalance.toString(),
    walletUsdfcBalanceRaw: walletUsdfcBalance.toString(),
    paymentUsdfcBalanceRaw: paymentUsdfcBalance.toString(),
    filecoinPayAllowanceRaw: filecoinPayAllowance.toString(),
    fwssApproved: fwssApproval.isApproved,
    fwssRateAllowance: fwssApproval.rateAllowance.toString(),
    fwssLockupAllowance: fwssApproval.lockupAllowance.toString(),
    fwssMaxLockupPeriod: fwssApproval.maxLockupPeriod.toString(),
    usdfcTokenAddress: chain.contracts.usdfc.address,
    filecoinPayAddress: chain.contracts.filecoinPay.address,
    warmStorageAddress: chain.contracts.fwss.address,
  };
}

export async function finalizeStorageUsdfcDeposit(
  userAddress: `0x${string}`,
  amount: bigint,
  transferHash?: `0x${string}`,
): Promise<DepositUsdfcResult> {
  if (amount <= BigInt(0)) throw new Error('USDFC amount must be greater than 0');

  const { synapse } = await createWalletSynapse(userAddress);
  const storageAccount = synapse.client.account.address as `0x${string}`;
  const chain = synapse.chain;

  console.log('[CSMA-USDFC] finalize deposit start:', {
    owner: userAddress,
    storageAccount,
    amount: amount.toString(),
    transferHash,
  });

  if (transferHash) {
    console.log('[CSMA-USDFC] waiting for wallet transfer:', transferHash);
    const receipt = await waitForTransactionReceipt(synapse.client, { hash: transferHash });
    if (receipt.status !== 'success') {
      throw new Error(`USDFC transfer transaction failed: ${transferHash}`);
    }
    const transferLogs = parseEventLogs({
      abi: erc20Abi,
      logs: receipt.logs,
      eventName: 'Transfer',
      strict: false,
    });
    const matchingTransfer = transferLogs.find((log) => {
      const args = log.args as { from?: `0x${string}`; to?: `0x${string}`; value?: bigint };
      return (
        isAddressEqual(log.address, chain.contracts.usdfc.address) &&
        args.from != null &&
        args.to != null &&
        isAddressEqual(args.from, userAddress) &&
        isAddressEqual(args.to, storageAccount) &&
        args.value === amount
      );
    });
    if (!matchingTransfer) {
      throw new Error('Transfer transaction did not send the requested USDFC amount to the storage account');
    }
    console.log('[CSMA-USDFC] wallet transfer confirmed:', transferHash);
  }

  const before = await getStorageFundingStatus(userAddress);
  console.log('[CSMA-USDFC] before:', before);
  if (BigInt(before.walletUsdfcBalanceRaw) < amount) {
    throw new Error(
      `Storage account did not receive enough USDFC. Wallet balance: ${before.walletUsdfcBalance}, required: ${formatEther(amount)}`,
    );
  }

  let approvalHash: `0x${string}` | undefined;
  const currentAllowance = BigInt(before.filecoinPayAllowanceRaw);
  if (currentAllowance < amount) {
    approvalHash = await synapse.payments.approve({
      spender: chain.contracts.filecoinPay.address,
      amount,
    });
    console.log('[CSMA-USDFC] approve FilecoinPay tx:', approvalHash);
    const receipt = await waitForTransactionReceipt(synapse.client, { hash: approvalHash });
    if (receipt.status !== 'success') throw new Error(`USDFC approve failed: ${approvalHash}`);
  }

  const depositHash = await synapse.payments.deposit({ amount, to: storageAccount });
  console.log('[CSMA-USDFC] deposit to Payments tx:', depositHash);
  const depositReceipt = await waitForTransactionReceipt(synapse.client, { hash: depositHash });
  if (depositReceipt.status !== 'success') throw new Error(`USDFC deposit failed: ${depositHash}`);

  let serviceApprovalHash: `0x${string}` | undefined;
  const { isFwssMaxApproved } = await import('@filoz/synapse-core/pay');
  const hasFwssApproval = await isFwssMaxApproved(synapse.client, { clientAddress: storageAccount });
  if (!hasFwssApproval) {
    serviceApprovalHash = await synapse.payments.approveService({
      service: chain.contracts.fwss.address,
    });
    console.log('[CSMA-USDFC] approve FWSS service tx:', serviceApprovalHash);
    const receipt = await waitForTransactionReceipt(synapse.client, { hash: serviceApprovalHash });
    if (receipt.status !== 'success') throw new Error(`Warm Storage approval failed: ${serviceApprovalHash}`);
  } else {
    console.log('[CSMA-USDFC] FWSS service already approved');
  }

  const after = await getStorageFundingStatus(userAddress);
  console.log('[CSMA-USDFC] after:', after);

  return {
    storageAccount,
    amount: amount.toString(),
    transferHash,
    approvalHash,
    depositHash,
    serviceApprovalHash,
    before,
    after,
  };
}

export async function approveWarmStorageForExistingBalance(
  userAddress: `0x${string}`,
): Promise<WarmStorageApprovalResult> {
  const { synapse } = await createWalletSynapse(userAddress);
  const storageAccount = synapse.client.account.address as `0x${string}`;
  const chain = synapse.chain;

  console.log('[CSMA-USDFC] approve Warm Storage start:', {
    owner: userAddress,
    storageAccount,
  });

  const before = await getStorageFundingStatus(userAddress);
  console.log('[CSMA-USDFC] approval before:', before);

  if (BigInt(before.paymentUsdfcBalanceRaw) <= BigInt(0)) {
    throw new Error('Storage account has no USDFC deposited in Filecoin Pay');
  }

  const { isFwssMaxApproved } = await import('@filoz/synapse-core/pay');
  const hasFwssApproval = await isFwssMaxApproved(synapse.client, { clientAddress: storageAccount });
  let serviceApprovalHash: `0x${string}` | undefined;
  if (!hasFwssApproval) {
    serviceApprovalHash = await synapse.payments.approveService({
      service: chain.contracts.fwss.address,
    });
    console.log('[CSMA-USDFC] approve FWSS service tx:', serviceApprovalHash);
    const receipt = await waitForTransactionReceipt(synapse.client, { hash: serviceApprovalHash });
    if (receipt.status !== 'success') throw new Error(`Warm Storage approval failed: ${serviceApprovalHash}`);
  } else {
    console.log('[CSMA-USDFC] FWSS service already approved');
  }

  const after = await getStorageFundingStatus(userAddress);
  console.log('[CSMA-USDFC] approval after:', after);

  return {
    storageAccount,
    serviceApprovalHash,
    before,
    after,
  };
}

export async function depositExistingStorageWalletUsdfc(
  userAddress: `0x${string}`,
  requestedAmount?: bigint,
): Promise<ExistingUsdfcDepositResult> {
  const { synapse } = await createWalletSynapse(userAddress);
  const storageAccount = synapse.client.account.address as `0x${string}`;
  const chain = synapse.chain;

  console.log('[CSMA-USDFC] deposit existing wallet USDFC start:', {
    owner: userAddress,
    storageAccount,
    requestedAmount: requestedAmount?.toString(),
  });

  const before = await getStorageFundingStatus(userAddress);
  console.log('[CSMA-USDFC] existing deposit before:', before);

  const walletBalance = BigInt(before.walletUsdfcBalanceRaw);
  if (walletBalance <= BigInt(0)) {
    throw new Error('Storage account USDFC wallet balance is 0');
  }

  const amount = requestedAmount == null || requestedAmount <= BigInt(0)
    ? walletBalance
    : requestedAmount;
  if (amount > walletBalance) {
    throw new Error(
      `Storage account USDFC wallet balance is too low. Wallet balance: ${before.walletUsdfcBalance}, requested: ${formatEther(amount)}`,
    );
  }

  let approvalHash: `0x${string}` | undefined;
  const currentAllowance = BigInt(before.filecoinPayAllowanceRaw);
  if (currentAllowance < amount) {
    approvalHash = await synapse.payments.approve({
      spender: chain.contracts.filecoinPay.address,
      amount,
    });
    console.log('[CSMA-USDFC] approve FilecoinPay tx:', approvalHash);
    const receipt = await waitForTransactionReceipt(synapse.client, { hash: approvalHash });
    if (receipt.status !== 'success') throw new Error(`USDFC approve failed: ${approvalHash}`);
  }

  const depositHash = await synapse.payments.deposit({ amount, to: storageAccount });
  console.log('[CSMA-USDFC] deposit existing wallet USDFC tx:', depositHash);
  const depositReceipt = await waitForTransactionReceipt(synapse.client, { hash: depositHash });
  if (depositReceipt.status !== 'success') throw new Error(`USDFC deposit failed: ${depositHash}`);

  const after = await getStorageFundingStatus(userAddress);
  console.log('[CSMA-USDFC] existing deposit after:', after);

  return {
    storageAccount,
    amount: amount.toString(),
    approvalHash,
    depositHash,
    before,
    after,
  };
}

export async function getSessionKeyStatus(userAddress: `0x${string}`): Promise<{
  authorized: boolean; sessionKeyAddress?: string; expiresAt?: number;
}> {
  const entry = await getCacheEntry(userAddress);
  if (!entry) return { authorized: false };
  return { authorized: entry.authorized, sessionKeyAddress: entry.address, expiresAt: entry.expiresAt };
}

export { calibration };
