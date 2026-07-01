'use client';

import Image from 'next/image';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';

const WALLET_KEY = 'csma_wallet_address';
const CALIBRATION_CHAIN_ID = '0x4CB2F';
const TFIL_FAUCET_URL = 'https://faucet.calibnet.chainsafe-fil.io/funds.html';
const USDFC_FAUCET_URL = 'https://forest-explorer.chainsafe.dev/faucet/calibnet_usdfc';
const ERC20_TRANSFER_ABI = [{
  type: 'function',
  name: 'transfer',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  outputs: [{ name: '', type: 'bool' }],
}] as const;

function shorten(a: string) { return `${a.slice(0, 6)}...${a.slice(-4)}`; }

function formatBalance(value?: string | number | null, suffix = '') {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return suffix ? `0 ${suffix}` : '0';
  return `${parsed.toFixed(4)}${suffix ? ` ${suffix}` : ''}`;
}

function parseTokenAmount(value: string) {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{0,18})?$/.test(trimmed)) throw new Error('Invalid amount');
  const [whole, frac = ''] = trimmed.split('.');
  return BigInt(whole + frac.padEnd(18, '0'));
}

function StatusDot({ ok, warn }: { ok?: boolean; warn?: boolean }) {
  const color = ok ? 'oklch(0.62 0.15 160)' : warn ? 'oklch(0.72 0.14 78)' : 'oklch(0.68 0.02 215)';
  return <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />;
}

async function detectProvider() {
  const e = (window as any).ethereum;
  if (e && e.request) { console.log('[CSMA] provider via window.ethereum'); return e; }
  try {
    const p = await new Promise<any>((resolve) => {
      const handler = (event: any) => {
        window.removeEventListener('eip6963:announceProvider', handler);
        resolve(event.detail.provider);
      };
      window.addEventListener('eip6963:announceProvider', handler);
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      setTimeout(() => { window.removeEventListener('eip6963:announceProvider', handler); resolve(null); }, 2000);
    });
    if (p) return p;
  } catch {}
  return null;
}

export default function ProfilePage() {
  const router = useRouter();
  const [walletAddr, setWalletAddr] = useState<string | null>(null);
  const [storageInfo, setStorageInfo] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [fundAmount, setFundAmount] = useState('0.5');
  const [usdfcAmount, setUsdfcAmount] = useState('1');
  const [funding, setFunding] = useState(false);
  const [depositingUsdfc, setDepositingUsdfc] = useState(false);
  const [convertingWalletUsdfc, setConvertingWalletUsdfc] = useState(false);
  const [approvingWarmStorage, setApprovingWarmStorage] = useState(false);
  const [depositResult, setDepositResult] = useState<any>(null);
  const [convertResult, setConvertResult] = useState<any>(null);
  const [approvalResult, setApprovalResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem(WALLET_KEY);
    if (saved) setWalletAddr(saved);

    fetch('/api/chat')
      .then(r => r.json())
      .then(d => { setStorageInfo(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const refreshStorageInfo = useCallback(async (addr = walletAddr) => {
    if (!addr) return;
    const r = await fetch('/api/chat');
    setStorageInfo(await r.json());
  }, [walletAddr]);

  const connectWallet = useCallback(async () => {
    const e = await detectProvider();
    if (!e) { setError('No wallet found.'); return; }
    try {
      const raw = await e.request({ method: 'eth_requestAccounts' });
      const result = raw !== null ? JSON.parse(JSON.stringify(raw)) : null;
      let addr: string | null = null;
      try { if (result && result.length > 0) addr = String(result[0]); } catch {}
      if (!addr) try { if (e.selectedAddress) addr = e.selectedAddress; } catch {}
      if (addr) {
        const nonceRes = await fetch('/api/auth/nonce', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletAddress: addr }),
        });
        const nonce = await nonceRes.json();
        if (!nonceRes.ok) throw new Error(nonce.error || 'Failed to create sign-in challenge.');
        const signature = await e.request({ method: 'personal_sign', params: [nonce.message, addr] });
        const verifyRes = await fetch('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletAddress: addr, signature }),
        });
        const verified = await verifyRes.json();
        if (!verifyRes.ok || !verified.authenticated) throw new Error(verified.error || 'Wallet sign-in failed.');
        setWalletAddr(addr);
        localStorage.setItem(WALLET_KEY, addr);
        await refreshStorageInfo(addr);
      }
    } catch (err: any) {
      if (err.code !== 4001) setError('Failed to connect.');
    }
  }, [refreshStorageInfo]);

  const disconnectWallet = useCallback(() => {
    fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setWalletAddr(null);
    localStorage.removeItem(WALLET_KEY);
    setStorageInfo(null);
  }, []);

  const fundAccount = useCallback(async () => {
    if (!walletAddr || !storageInfo?.sessionKeyAddress) return;
    const e = await detectProvider();
    if (!e) { setError('No wallet found.'); return; }
    setFunding(true);
    setError(null);
    try {
      await e.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CALIBRATION_CHAIN_ID }] });
      const amt = parseFloat(fundAmount);
      if (isNaN(amt) || amt <= 0) { setError('Invalid amount'); return; }
      const amountWei = BigInt(Math.floor(amt * 1e18));
      const txHash = await e.request({
        method: 'eth_sendTransaction',
        params: [{
          from: walletAddr,
          to: storageInfo.sessionKeyAddress,
          value: '0x' + amountWei.toString(16),
        }],
      });
      console.log('[CSMA] fund tx:', txHash);
      await refreshStorageInfo();
    } catch (err: any) {
      if (err?.code !== 4001) setError('Funding failed: ' + (err.message || err));
    } finally {
      setFunding(false);
    }
  }, [walletAddr, storageInfo, fundAmount, refreshStorageInfo]);

  const isAuthorized = storageInfo?.filecoinAuthorized ?? false;
  const hasPaymentUsdfc = Number(storageInfo?.usdfcBalance || '0') > 0;
  const hasWalletUsdfc = Number(storageInfo?.storageUsdfcWalletBalance || '0') > 0;
  const needsWarmStorageApproval = isAuthorized && hasPaymentUsdfc && !storageInfo?.fwssApproved;
  const storageReady = isAuthorized && hasPaymentUsdfc && !!storageInfo?.fwssApproved;
  const canManageStorage = !!walletAddr && isAuthorized && !loading;

  const depositUsdfc = useCallback(async () => {
    if (!walletAddr || !storageInfo?.sessionKeyAddress || !storageInfo?.usdfcTokenAddress) return;
    const e = await detectProvider();
    if (!e) { setError('No wallet found.'); return; }
    setDepositingUsdfc(true);
    setDepositResult(null);
    setError(null);
    try {
      await e.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CALIBRATION_CHAIN_ID }] });
      const amountRaw = parseTokenAmount(usdfcAmount);
      if (amountRaw <= BigInt(0)) throw new Error('Invalid amount');

      console.log('[CSMA-USDFC] transfer start:', {
        from: walletAddr,
        to: storageInfo.sessionKeyAddress,
        token: storageInfo.usdfcTokenAddress,
        amount: amountRaw.toString(),
      });

      const { encodeFunctionData } = await import('viem');
      const transferData = encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: 'transfer',
        args: [storageInfo.sessionKeyAddress, amountRaw],
      });
      const transferHash = await e.request({
        method: 'eth_sendTransaction',
        params: [{
          from: walletAddr,
          to: storageInfo.usdfcTokenAddress,
          data: transferData,
        }],
      });
      console.log('[CSMA-USDFC] transfer tx:', transferHash);

      const r = await fetch('/api/chat/deposit-usdfc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: walletAddr, amount: usdfcAmount, transferHash }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || 'USDFC deposit failed');
      setDepositResult(d);
      await refreshStorageInfo();
    } catch (err: any) {
      if (err?.code !== 4001) setError('USDFC deposit failed: ' + (err.message || err));
    } finally {
      setDepositingUsdfc(false);
    }
  }, [walletAddr, storageInfo, usdfcAmount, refreshStorageInfo]);

  const convertWalletUsdfc = useCallback(async () => {
    if (!walletAddr || !isAuthorized) return;
    setConvertingWalletUsdfc(true);
    setConvertResult(null);
    setError(null);
    try {
      const r = await fetch('/api/chat/deposit-existing-usdfc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: walletAddr }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || 'USDFC conversion failed');
      setConvertResult(d);
      await refreshStorageInfo();
    } catch (err: any) {
      setError('USDFC conversion failed: ' + (err.message || err));
    } finally {
      setConvertingWalletUsdfc(false);
    }
  }, [walletAddr, isAuthorized, refreshStorageInfo]);

  const approveWarmStorage = useCallback(async () => {
    if (!walletAddr || !isAuthorized) return;
    setApprovingWarmStorage(true);
    setApprovalResult(null);
    setError(null);
    try {
      const r = await fetch('/api/chat/approve-warm-storage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: walletAddr }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || 'Warm Storage approval failed');
      setApprovalResult(d);
      await refreshStorageInfo();
    } catch (err: any) {
      setError('Warm Storage approval failed: ' + (err.message || err));
    } finally {
      setApprovingWarmStorage(false);
    }
  }, [walletAddr, isAuthorized, refreshStorageInfo]);

  return (
    <div className="app-shell">
      <div className="app-window flex flex-col">
        <header className="flex items-center justify-between border-b border-line bg-[oklch(0.99_0.006_190_/_0.82)] px-6 py-4">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push('/')} className="icon-button" aria-label="Back to chat">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 19 3 12m0 0 7-7m-7 7h18" />
              </svg>
            </button>
            <div className="brand-mark">
              <Image src="/logo.png" alt="Memory Agent logo" width={36} height={36} priority />
            </div>
            <div>
              <h1 className="text-base font-semibold">Profile</h1>
              <p className="text-xs text-muted">Wallet, storage account, and Filecoin Pay status</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => refreshStorageInfo()} disabled={!walletAddr || loading} className="secondary-button">Refresh</button>
            <button onClick={() => router.push('/memory')} className="secondary-button">Memory</button>
          </div>
        </header>

        <main className="scrollbar-thin mx-auto w-full max-w-6xl flex-1 overflow-y-auto px-6 py-6">
          {error && (
            <div className="mb-5 rounded-lg border border-[oklch(0.82_0.07_28)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]">
              {error}
            </div>
          )}

          <section className="mb-5 grid gap-3 md:grid-cols-4">
            <div className="soft-panel rounded-lg p-4">
              <div className="text-xs text-muted">Connected wallet</div>
              <div className="mt-2 flex items-center gap-2 text-sm font-semibold">
                <StatusDot ok={!!walletAddr} />
                {walletAddr ? shorten(walletAddr) : 'Not connected'}
              </div>
            </div>
            <div className="soft-panel rounded-lg p-4">
              <div className="text-xs text-muted">Session key</div>
              <div className="mt-2 flex items-center gap-2 text-sm font-semibold">
                <StatusDot ok={isAuthorized} warn={!!walletAddr && !isAuthorized} />
                {isAuthorized ? 'Authorized' : walletAddr ? 'Needs auth' : 'Waiting'}
              </div>
            </div>
            <div className="soft-panel rounded-lg p-4">
              <div className="text-xs text-muted">Filecoin Pay</div>
              <div className="mt-2 flex items-center gap-2 text-sm font-semibold">
                <StatusDot ok={hasPaymentUsdfc} warn={isAuthorized && !hasPaymentUsdfc} />
                {formatBalance(storageInfo?.usdfcBalance, 'USDFC')}
              </div>
            </div>
            <div className="soft-panel rounded-lg p-4">
              <div className="text-xs text-muted">Storage status</div>
              <div className="mt-2 flex items-center gap-2 text-sm font-semibold">
                <StatusDot ok={storageReady} warn={isAuthorized && !storageReady} />
                {storageReady ? 'Ready' : isAuthorized ? 'Needs setup' : 'Local only'}
              </div>
            </div>
          </section>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-5">
              <section className="panel rounded-lg p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold">Account Overview</h2>
                    <p className="mt-1 text-sm leading-6 text-muted">
                      The connected wallet owns the storage account. The storage account pays gas and performs Filecoin Pay operations.
                    </p>
                  </div>
                  <span className={`status-pill ${storageReady ? 'status-ok' : isAuthorized ? 'status-warn' : 'status-muted'}`}>
                    <StatusDot ok={storageReady} warn={isAuthorized && !storageReady} />
                    {storageReady ? 'Storage ready' : isAuthorized ? 'Funding needed' : 'Setup needed'}
                  </span>
                </div>

                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <div className="soft-panel rounded-lg p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-[0.14em] text-faint">Wallet</span>
                      {walletAddr ? <span className="status-pill status-ok"><StatusDot ok /> Connected</span> : <span className="status-pill status-muted">Disconnected</span>}
                    </div>
                    {walletAddr ? (
                      <div className="space-y-3">
                        <code className="block break-all text-xs text-[var(--ink)]">{walletAddr}</code>
                        <button onClick={disconnectWallet} className="secondary-button">Disconnect</button>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <p className="text-sm text-muted">Connect a browser wallet to create and fund your Filecoin storage account.</p>
                        <button onClick={connectWallet} className="primary-button">Connect Wallet</button>
                      </div>
                    )}
                  </div>

                  <div className="soft-panel rounded-lg p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-[0.14em] text-faint">Session Key</span>
                      {isAuthorized ? <span className="status-pill status-ok"><StatusDot ok /> Authorized</span> : <span className="status-pill status-warn"><StatusDot warn /> Pending</span>}
                    </div>
                    {loading ? (
                      <p className="text-sm text-muted">Loading storage account...</p>
                    ) : !walletAddr ? (
                      <p className="text-sm text-muted">Connect a wallet first.</p>
                    ) : isAuthorized ? (
                      <div className="space-y-3">
                        <code className="block break-all text-xs text-[var(--ink)]">{storageInfo?.sessionKeyAddress || 'No session key address'}</code>
                        <button onClick={() => router.push('/')} className="secondary-button">Open chat</button>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <p className="text-sm text-muted">Authorize storage from the chat page to create the session key used for quiet writes.</p>
                        <button onClick={() => router.push('/')} className="primary-button">Authorize Storage</button>
                      </div>
                    )}
                  </div>
                </div>
              </section>

              <section className="panel rounded-lg p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold">Balances</h2>
                    <p className="mt-1 text-sm leading-6 text-muted">
                      Gas is paid in tFIL. Warm Storage spending comes from Filecoin Pay USDFC balance after approval.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <a href={TFIL_FAUCET_URL} target="_blank" rel="noreferrer" className="secondary-button">Get tFIL</a>
                    <a href={USDFC_FAUCET_URL} target="_blank" rel="noreferrer" className="secondary-button">Get USDFC</a>
                    <button onClick={() => refreshStorageInfo()} disabled={!walletAddr} className="secondary-button">Refresh balances</button>
                  </div>
                </div>

                {!canManageStorage ? (
                  <div className="mt-5 rounded-lg border border-line bg-[var(--surface-2)] p-4 text-sm text-muted">
                    {loading ? 'Loading account data...' : 'Connect and authorize a wallet to view storage balances.'}
                  </div>
                ) : (
                  <div className="mt-5 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border border-line bg-[oklch(0.99_0.006_190)] p-4">
                      <div className="text-xs text-muted">Storage Account tFIL</div>
                      <div className="mt-2 text-xl font-semibold">{formatBalance(storageInfo?.sessionKeyBalance, 'tFIL')}</div>
                      <p className="mt-2 text-xs leading-5 text-muted">Used by the storage account to pay gas for deposit and approval transactions.</p>
                    </div>
                    <div className="rounded-lg border border-line bg-[oklch(0.99_0.006_190)] p-4">
                      <div className="text-xs text-muted">Filecoin Pay USDFC Balance</div>
                      <div className="mt-2 text-xl font-semibold">{formatBalance(storageInfo?.usdfcBalance, 'USDFC')}</div>
                      <p className="mt-2 text-xs leading-5 text-muted">This is the balance Warm Storage bills against when memory is uploaded.</p>
                    </div>
                    <div className="rounded-lg border border-line bg-[oklch(0.99_0.006_190)] p-4">
                      <div className="text-xs text-muted">Storage Account USDFC Wallet</div>
                      <div className="mt-2 text-xl font-semibold">{formatBalance(storageInfo?.storageUsdfcWalletBalance, 'USDFC')}</div>
                      <p className="mt-2 text-xs leading-5 text-muted">USDFC held directly by the storage account before being deposited into Filecoin Pay.</p>
                    </div>
                    <div className="rounded-lg border border-line bg-[oklch(0.99_0.006_190)] p-4">
                      <div className="text-xs text-muted">Warm Storage Approval</div>
                      <div className="mt-2 text-xl font-semibold">{storageInfo?.fwssApproved ? 'Approved' : 'Not approved'}</div>
                      <p className="mt-2 text-xs leading-5 text-muted">Approval lets Warm Storage spend deposited Filecoin Pay USDFC for uploads.</p>
                    </div>
                  </div>
                )}
              </section>

              <section className="panel rounded-lg p-5">
                <h2 className="text-base font-semibold">Funding Actions</h2>
                <p className="mt-1 text-sm leading-6 text-muted">
                  Top up gas, move USDFC into the storage account, convert wallet USDFC to Filecoin Pay, or approve Warm Storage.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <a href={TFIL_FAUCET_URL} target="_blank" rel="noreferrer" className="secondary-button">Claim Calibration tFIL</a>
                  <a href={USDFC_FAUCET_URL} target="_blank" rel="noreferrer" className="secondary-button">Claim Calibration USDFC</a>
                </div>

                <div className="mt-5 grid gap-4">
                  <div className="rounded-lg border border-line bg-[var(--surface-2)] p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold">Fund gas</div>
                        <p className="mt-1 text-xs leading-5 text-muted">Send tFIL from the connected wallet to the storage account.</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <input type="text" value={fundAmount} onChange={e => setFundAmount(e.target.value)} className="field w-24 px-3 py-2 text-center text-sm" placeholder="0.5" />
                        <span className="text-xs text-muted">tFIL</span>
                        <button onClick={fundAccount} disabled={funding || !canManageStorage} className="primary-button">
                          {funding ? 'Sending...' : 'Fund'}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-line bg-[var(--surface-2)] p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold">Deposit USDFC</div>
                        <p className="mt-1 text-xs leading-5 text-muted">
                          Transfer USDFC from the connected wallet to the storage account, then deposit it into Filecoin Pay and approve Warm Storage.
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <input type="text" value={usdfcAmount} onChange={e => setUsdfcAmount(e.target.value)} className="field w-24 px-3 py-2 text-center text-sm" placeholder="1" />
                        <span className="text-xs text-muted">USDFC</span>
                        <button onClick={depositUsdfc} disabled={depositingUsdfc || !canManageStorage || !storageInfo?.usdfcTokenAddress} className="primary-button">
                          {depositingUsdfc ? 'Depositing...' : 'Deposit'}
                        </button>
                      </div>
                    </div>
                    {depositResult && (
                      <div className="mt-3 space-y-1 rounded-lg border border-line bg-[oklch(0.99_0.006_190)] p-3 text-[11px] text-muted">
                        {depositResult.transferHash && <p>Transfer: <code className="text-[var(--ink)]">{shorten(depositResult.transferHash)}</code></p>}
                        {depositResult.approvalHash && <p>Approve Filecoin Pay: <code className="text-[var(--ink)]">{shorten(depositResult.approvalHash)}</code></p>}
                        {depositResult.depositHash && <p>Deposit: <code className="text-[var(--ink)]">{shorten(depositResult.depositHash)}</code></p>}
                        {depositResult.serviceApprovalHash && <p>Approve Warm Storage: <code className="text-[var(--ink)]">{shorten(depositResult.serviceApprovalHash)}</code></p>}
                        <p className="font-semibold text-[oklch(0.43_0.12_160)]">USDFC funding complete.</p>
                      </div>
                    )}
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="rounded-lg border border-line bg-[var(--surface-2)] p-4">
                      <div className="text-sm font-semibold">Convert storage wallet USDFC</div>
                      <p className="mt-1 text-xs leading-5 text-muted">Move existing storage account USDFC wallet balance into Filecoin Pay balance.</p>
                      <button onClick={convertWalletUsdfc} disabled={convertingWalletUsdfc || !canManageStorage || !hasWalletUsdfc} className="secondary-button mt-4">
                        {convertingWalletUsdfc ? 'Converting...' : 'Convert'}
                      </button>
                      {convertResult && (
                        <div className="mt-3 space-y-1 rounded-lg border border-line bg-[oklch(0.99_0.006_190)] p-3 text-[11px] text-muted">
                          {convertResult.approvalHash && <p>Approve Filecoin Pay: <code className="text-[var(--ink)]">{shorten(convertResult.approvalHash)}</code></p>}
                          {convertResult.depositHash && <p>Deposit: <code className="text-[var(--ink)]">{shorten(convertResult.depositHash)}</code></p>}
                          <p className="font-semibold text-[oklch(0.43_0.12_160)]">Storage wallet USDFC converted.</p>
                        </div>
                      )}
                    </div>

                    <div className="rounded-lg border border-line bg-[var(--surface-2)] p-4">
                      <div className="text-sm font-semibold">Warm Storage approval</div>
                      <p className="mt-1 text-xs leading-5 text-muted">Run this when Filecoin Pay has USDFC but Warm Storage is still pending.</p>
                      <button onClick={approveWarmStorage} disabled={approvingWarmStorage || !needsWarmStorageApproval} className="secondary-button mt-4">
                        {approvingWarmStorage ? 'Approving...' : storageInfo?.fwssApproved ? 'Approved' : 'Approve Warm Storage'}
                      </button>
                      {approvalResult && (
                        <div className="mt-3 space-y-1 rounded-lg border border-line bg-[oklch(0.99_0.006_190)] p-3 text-[11px] text-muted">
                          {approvalResult.serviceApprovalHash ? (
                            <p>Approve Warm Storage: <code className="text-[var(--ink)]">{shorten(approvalResult.serviceApprovalHash)}</code></p>
                          ) : (
                            <p className="font-semibold text-[oklch(0.43_0.12_160)]">Warm Storage was already approved.</p>
                          )}
                          <p className="font-semibold text-[oklch(0.43_0.12_160)]">Warm Storage approval complete.</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </section>
            </div>

            <aside className="space-y-5">
              <section className="panel rounded-lg p-5">
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-faint">Pipeline</div>
                <div className="mt-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <StatusDot ok={!!walletAddr} />
                    <div>
                      <div className="text-sm font-semibold">Wallet connected</div>
                      <p className="text-xs text-muted">{walletAddr ? shorten(walletAddr) : 'Waiting for wallet'}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <StatusDot ok={isAuthorized} warn={!!walletAddr && !isAuthorized} />
                    <div>
                      <div className="text-sm font-semibold">Session key authorized</div>
                      <p className="text-xs text-muted">{storageInfo?.sessionKeyAddress ? shorten(storageInfo.sessionKeyAddress) : 'No storage account yet'}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <StatusDot ok={hasPaymentUsdfc} warn={isAuthorized && !hasPaymentUsdfc} />
                    <div>
                      <div className="text-sm font-semibold">USDFC deposited</div>
                      <p className="text-xs text-muted">{formatBalance(storageInfo?.usdfcBalance, 'USDFC')}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <StatusDot ok={!!storageInfo?.fwssApproved} warn={hasPaymentUsdfc && !storageInfo?.fwssApproved} />
                    <div>
                      <div className="text-sm font-semibold">Warm Storage approved</div>
                      <p className="text-xs text-muted">{storageInfo?.fwssApproved ? 'Ready for uploads' : 'Approval pending'}</p>
                    </div>
                  </div>
                </div>
              </section>

              {storageInfo && (
                <section className="panel rounded-lg p-5">
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-faint">Network</div>
                  <div className="mt-4 space-y-3 text-xs text-muted">
                    <div className="flex justify-between gap-3"><span>Type</span><span className="font-medium text-[var(--ink)]">{storageInfo.type}</span></div>
                    {storageInfo.type === 'filecoin' && (
                      <div className="flex justify-between gap-3"><span>Network</span><span className="font-medium text-[var(--ink)]">{storageInfo.details?.network || 'calibration'}</span></div>
                    )}
                    {storageInfo?.warmStorageAvailable !== undefined && (
                      <div className="flex justify-between gap-3"><span>Warm Storage</span><span className="font-medium text-[var(--ink)]">{storageInfo.warmStorageAvailable ? 'Active' : 'Unavailable'}</span></div>
                    )}
                    {storageInfo?.usdfcTokenAddress && <div><span>USDFC</span><code className="mt-1 block break-all text-[var(--ink)]">{storageInfo.usdfcTokenAddress}</code></div>}
                    {storageInfo?.filecoinPayAddress && <div><span>Filecoin Pay</span><code className="mt-1 block break-all text-[var(--ink)]">{storageInfo.filecoinPayAddress}</code></div>}
                    {storageInfo?.warmStorageAddress && <div><span>Warm Storage Contract</span><code className="mt-1 block break-all text-[var(--ink)]">{storageInfo.warmStorageAddress}</code></div>}
                  </div>
                </section>
              )}
            </aside>
          </div>
        </main>
      </div>
    </div>
  );
}
