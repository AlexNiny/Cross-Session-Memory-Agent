'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

type Message = { role: 'user' | 'agent'; content: string };
type StorageInfo = {
  type: string; filecoinAuthorized: boolean; demoMode: boolean;
  memoryLimit: number; defaultProviderUrl: string; defaultModel: string;
  details: Record<string, string>;
  sessionKeyAddress?: string;
  sessionKeyBalance?: string;
  estimatedTurns?: number;
  warmStorageAvailable?: boolean;
  providerCount?: number;
};
interface LLMConfig { providerUrl: string; apiKey: string; model: string; }

const CFG_KEY = 'csma_llm_config';
const WALLET_KEY = 'csma_wallet_address';

function getOrCreateSessionId(): string {
  if (typeof window === 'undefined') return '';
  const k = 'csma_session_id';
  let id = localStorage.getItem(k);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(k, id); }
  return id;
}
function loadLLMConfig(d: { providerUrl: string; model: string }): LLMConfig {
  try { const r = localStorage.getItem(CFG_KEY); if (r) return JSON.parse(r); } catch {}
  return { providerUrl: d.providerUrl, apiKey: '', model: d.model };
}
function saveLLMConfig(c: LLMConfig) { localStorage.setItem(CFG_KEY, JSON.stringify(c)); }
function shorten(a: string) { return `${a.slice(0, 6)}...${a.slice(-4)}`; }


// ── Wallet provider detection (EIP-1193 + EIP-6963) ──
async function detectProvider() {
  console.log('[CSMA] detectProvider() called');
  const e = (window as any).ethereum;
  if (e && e.request) { console.log('[CSMA] detectProvider: found via window.ethereum'); return e; }
  console.log('[CSMA] detectProvider: window.ethereum not available, trying EIP-6963...');
  try {
    const p = await new Promise((resolve) => {
      const handler = (event: any) => {
        window.removeEventListener('eip6963:announceProvider', handler);
        resolve(event.detail.provider);
      };
      window.addEventListener('eip6963:announceProvider', handler);
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      setTimeout(() => {
        window.removeEventListener('eip6963:announceProvider', handler);
        resolve(null);
      }, 2000);
    });
    if (p) { console.log('[CSMA] detectProvider: found via EIP-6963'); return p; }
  } catch { console.log('[CSMA] detectProvider: EIP-6963 error'); }
  console.log('[CSMA] detectProvider: no provider found');
  return null;
}

export default function ChatPage() {
  const [sessionId] = useState(getOrCreateSessionId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [memoryCount, setMemoryCount] = useState(0);
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [llmConfig, setLlmConfig] = useState<LLMConfig>({ providerUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' });
  const [draft, setDraft] = useState<LLMConfig>({ ...llmConfig });
  const [showKey, setShowKey] = useState(false);

  // Wallet state (native — no wagmi/rainbowkit)
  const [walletAddr, setWalletAddr] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [sessionKeyAddr, setSessionKeyAddr] = useState<string | null>(null);

  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scroll = useCallback(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), []);

  // ── Init: restore wallet + messages from localStorage ──
  useEffect(() => {
    const savedWallet = localStorage.getItem(WALLET_KEY);
    if (savedWallet) setWalletAddr(savedWallet);

    const saved = localStorage.getItem(`csma_messages_${sessionId}`);
    if (saved) {
      try {
        const p = JSON.parse(saved) as Message[];
        setMessages(p);
        setMemoryCount(parseInt(localStorage.getItem(`csma_count_${sessionId}`) || '0', 10));
      } catch {}
    }
  }, [sessionId]);

  // ── Listen for wallet account changes (EIP-1193 + EIP-6963) ──
  useEffect(() => {
    const providers: any[] = [];
    const accountHandler = (accounts: any) => {
      console.log('[CSMA] accountsChanged event:', accounts);
      if (!accounts || accounts.length === 0) {
        setWalletAddr(null); localStorage.removeItem(WALLET_KEY);
      } else {
        const addr = String(accounts[0]);
        setWalletAddr(addr); localStorage.setItem(WALLET_KEY, addr);
      }
    };

    // Collect from window.ethereum
    const w = (window as any).ethereum;
    if (w && w.on) providers.push(w);

    // Also collect from EIP-6963 announcements
    const handler6963 = (event: any) => {
      const p = event.detail?.provider;
      if (p && p.on && !providers.includes(p)) {
        providers.push(p);
        p.on('accountsChanged', accountHandler);
      }
    };
    window.addEventListener('eip6963:announceProvider', handler6963);
    window.dispatchEvent(new Event('eip6963:requestProvider'));

    for (const p of providers) {
      try { p.on('accountsChanged', accountHandler); } catch {}
    }

    return () => {
      window.removeEventListener('eip6963:announceProvider', handler6963);
      for (const p of providers) {
        try { p.removeListener?.('accountsChanged', accountHandler); } catch {}
      }
    };
  }, []);

  // ── Fetch storage info when wallet changes ──
  useEffect(() => {
    const params = walletAddr ? `?wallet=${walletAddr}` : '';
    fetch(`/api/chat${params}`)
      .then(r => r.json())
      .then((d: StorageInfo) => {
        setStorageInfo(d);
        const cfg = loadLLMConfig({ providerUrl: d.defaultProviderUrl, model: d.defaultModel });
        setLlmConfig(cfg); setDraft(cfg);
      })
      .catch(() => {});
  console.log('[CSMA] walletAddr changed:', walletAddr);
  }, [walletAddr]);

  // ── Persist messages ──
  useEffect(() => {
    if (messages.length > 0) localStorage.setItem(`csma_messages_${sessionId}`, JSON.stringify(messages));
  }, [messages, sessionId]);
  useEffect(() => { scroll(); }, [messages, scroll]);
  const persist = useCallback((msgs: Message[]) => localStorage.setItem(`csma_messages_${sessionId}`, JSON.stringify(msgs)), [sessionId]);

  // ── Connect wallet (native eth_requestAccounts) ──
  const connectWallet = useCallback(async () => {
    const e = await detectProvider();
    if (!e) { setError('No wallet found. Please install MetaMask.'); return; }
    setConnecting(true); setError(null);
    try {
      // 1. Trigger MetaMask connection popup
      console.log('[CSMA] connectWallet: eth_requestAccounts called');
      await e.request({ method: 'eth_requestAccounts' });
      console.log('[CSMA] connectWallet: eth_requestAccounts resolved');
      // 2. Read accounts directly (reliable, no event dependency)
      const accts = await e.request({ method: 'eth_accounts' });
      console.log('[CSMA] connectWallet: eth_accounts returned:', accts);
      let addr = null;
      try { if (accts && accts.length > 0) addr = String(accts[0]); } catch {}
      if (!addr) { try { if ((window as any).ethereum?.selectedAddress) addr = (window as any).ethereum.selectedAddress; } catch {} }
      if (addr) {
        console.log('[CSMA] connectWallet: setting walletAddr =', addr);
        setWalletAddr(addr); localStorage.setItem(WALLET_KEY, addr);
      } else {
        console.log('[CSMA] connectWallet: no address extracted');
      }
    } catch (err: any) {
      if (err?.code !== 4001) setError('Failed to connect wallet.');
    } finally { setConnecting(false); }
  }, []);

  const disconnectWallet = useCallback(() => {
    setWalletAddr(null); localStorage.removeItem(WALLET_KEY);
    setLoginTx(null); setSessionKeyAddr(null);
  }, []);

  // Placeholder for the loginTx state (used in authorize + disconnect)
  const [loginTx, setLoginTx] = useState<any>(null);

  // ── Authorize session key ──
  const authorizeStorage = useCallback(async () => {
    console.log('[CSMA] authorizeStorage: started');
    if (!walletAddr) return;
    setAuthorizing(true); setError(null);
    const e = await detectProvider();
    if (!e) { setError('No wallet found.'); return; }
    try {
      // Switch to Filecoin Calibration chain (add if needed)
      try {
        await e.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x4CB2F' }] });
      } catch (switchErr: any) {
        if (switchErr.code === 4902) {
          await e.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: '0x4CB2F', chainName: 'Filecoin Calibration',
              nativeCurrency: { name: 'tFIL', symbol: 'tFIL', decimals: 18 },
              rpcUrls: ['https://rpc.ankr.com/filecoin_testnet'],
              blockExplorerUrls: ['https://calibration.filscan.io'],
            }],
          });
        } else throw switchErr;
      }

      const prepRes = await fetch('/api/chat/prepare-login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: walletAddr }),
      });
      const prep = await prepRes.json();
      console.log('[CSMA] authorizeStorage: prepare-login response:', prep);
      if (!prepRes.ok) throw new Error(prep.error);
      if (prep.alreadyAuthorized) { setSessionKeyAddr(prep.sessionKeyAddress); return; }
      setSessionKeyAddr(prep.sessionKeyAddress);

      const txHash: string = await e.request({
        method: 'eth_sendTransaction',
        params: [{ from: walletAddr, to: prep.to, data: prep.data, value: prep.suggestedValue }],
      });

      const confirmRes = await fetch('/api/chat/confirm-login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: walletAddr, txHash }),
      });
      const confirm = await confirmRes.json();
      console.log('[CSMA] authorizeStorage: confirm-login response:', confirm);
      if (!confirm.authorized) throw new Error(confirm.error || 'Authorization failed');

      const infoRes = await fetch(`/api/chat?wallet=${walletAddr}`);
      setStorageInfo(await infoRes.json());
    } catch (err: any) {
      if (err.code !== 4001) setError(err.message || 'Authorization failed');
    } finally { setAuthorizing(false); }
  }, [walletAddr]);

  // ── Chat ──
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;
    if (!llmConfig.apiKey) { setError('Configure API key in Settings first.'); return; }

    setInput(''); setError(null);
    const userMsg: Message = { role: 'user', content: text };
    const updated = [...messages, userMsg];
    setMessages(updated); persist(updated);
    setIsLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId, message: text,
          providerUrl: llmConfig.providerUrl, apiKey: llmConfig.apiKey, model: llmConfig.model,
          walletAddress: walletAddr || undefined,
        }),
      });
      if (!res.ok) { const e2 = await res.json().catch(() => ({})); throw new Error(e2.error || `Error ${res.status}`); }
      const data = await res.json();
      const agentMsg: Message = { role: 'agent', content: data.response };
      const final = [...updated, agentMsg];
      setMessages(final); persist(final);
      setMemoryCount(data.memoryCount);
      localStorage.setItem(`csma_count_${sessionId}`, String(data.memoryCount));
    } catch (err: any) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setIsLoading(false); }
  }, [input, isLoading, messages, sessionId, llmConfig, walletAddr, persist]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };
  const newSession = () => {
    const id = crypto.randomUUID();
    localStorage.setItem('csma_session_id', id);
    localStorage.removeItem(`csma_messages_${sessionId}`);
    localStorage.removeItem(`csma_count_${sessionId}`);
    window.location.reload();
  };

  const canChat = !!llmConfig.apiKey;
  const isAuthorized = storageInfo?.filecoinAuthorized ?? false;

  return (
    <div className="chat-container">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-dark-800 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-filecoin-600/20">
            <svg className="h-4 w-4 text-filecoin-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-semibold text-dark-50">Memory Agent</h1>
            <p className="text-xs text-dark-500">Cross-session persistent memory</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className={`inline-flex h-2 w-2 rounded-full ${canChat ? 'bg-green-500' : 'bg-red-500'}`}
            title={canChat ? 'API key set' : 'No API key'} />
          {isAuthorized ? (
            <span className="storage-badge storage-badge-filecoin">Filecoin</span>
          ) : walletAddr ? null : (
            <span className="storage-badge storage-badge-local">Local</span>
          )}

          {/* Wallet — native */}
          {walletAddr ? (
            <button onClick={disconnectWallet}
              className="inline-flex items-center gap-1.5 rounded-xl border border-dark-700 bg-dark-850 px-2.5 py-1.5 text-xs font-medium text-dark-300 hover:border-dark-600 transition-colors">
              <span className={`h-2 w-2 rounded-full ${isAuthorized ? 'bg-green-500' : 'bg-yellow-500'}`} />
              {shorten(walletAddr)}
            </button>
          ) : (
            <button onClick={connectWallet} disabled={connecting}
              className="inline-flex items-center gap-1.5 rounded-xl border border-dark-700 bg-dark-850 px-2.5 py-1.5 text-xs font-medium text-dark-400 hover:border-dark-500 transition-colors disabled:opacity-50">
              {connecting ? 'Connecting...' : 'Connect Wallet'}
            </button>
          )}

          <a href="/memory" className="rounded-lg p-2 text-dark-500 hover:bg-dark-800 transition-colors" title="Memory Explorer">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
          </a>
          <button onClick={() => setShowSettings(!showSettings)} className="rounded-lg p-2 text-dark-500 hover:bg-dark-800 transition-colors" title="Settings">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
          <button onClick={() => setShowInfo(!showInfo)} className="rounded-lg p-2 text-dark-500 hover:bg-dark-800 transition-colors" title="Info">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
          <button onClick={newSession} className="rounded-lg p-2 text-dark-500 hover:bg-dark-800 transition-colors" title="New session">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>
      </header>

      {/* Authorize Banner */}
      {walletAddr && !isAuthorized && (
        <div className="border-b border-dark-800 bg-dark-900/60 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-yellow-600/20">
                <svg className="h-4 w-4 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L4.07 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <div>
                <p className="text-xs font-medium text-dark-300">Authorize session key to enable Filecoin storage</p>
                <p className="text-xs text-dark-500">One-time transaction (~0.1 tFIL) to register your session key</p>
              </div>
            </div>
            <button onClick={authorizeStorage} disabled={authorizing}
              className="shrink-0 rounded-xl bg-filecoin-600 px-4 py-2 text-xs font-medium text-white hover:bg-filecoin-500 transition-colors disabled:opacity-50">
              {authorizing ? 'Authorizing...' : 'Authorize Storage'}
            </button>
          </div>
        </div>
      )}

      {walletAddr && isAuthorized && sessionKeyAddr && (
        <div className="border-b border-dark-800 bg-dark-900/40 px-4 py-2 text-xs text-dark-400">
          <span>Session Key: <code className="text-green-400">{shorten(sessionKeyAddr)}</code></span>
          {storageInfo?.sessionKeyBalance && (
            <span className="ml-3">
              Balance: <code className="text-dark-300">{Number(storageInfo.sessionKeyBalance).toFixed(4)} tFIL</code>
              {storageInfo?.estimatedTurns !== undefined && storageInfo.estimatedTurns >= 0 && (
                <span className="ml-1">(~{storageInfo.estimatedTurns} turns)</span>
              )}
              <span className="ml-3">
                Storage:{' '}
                {storageInfo?.warmStorageAvailable ? (
                  <code className="text-green-400">Active</code>
                ) : (
                  <code className="text-yellow-500">No providers</code>
                )}
              </span>
            </span>
          )}
        </div>
      )}

      {showInfo && (
        <div className="border-b border-dark-800 bg-dark-900/50 px-4 py-3 text-xs text-dark-400">
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span>Session: <code className="text-dark-300">{sessionId.slice(0, 8)}...</code></span>
            <span>Memory: <code className="text-dark-300">{memoryCount} turns</code></span>
            <span>Model: <code className="text-dark-300">{llmConfig.model}</code></span>
            {walletAddr && <span>Wallet: <code className="text-green-400">{shorten(walletAddr)}</code></span>}
            <span>Backend: <code className={isAuthorized ? 'text-filecoin-400' : 'text-dark-400'}>{isAuthorized ? 'Filecoin (calibration)' : 'Local'}</code></span>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="scrollbar-thin flex-1 overflow-y-auto py-4 space-y-4">
        {messages.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center py-16 text-dark-500">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-dark-800">
              <svg className="h-8 w-8 text-dark-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
            </div>
            <p className="text-sm font-medium">Your memory agent is ready</p>
            <p className="mt-1 text-xs text-center max-w-xs">
              {!canChat && 'Configure your API key in Settings to start.'}
              {canChat && !walletAddr && 'Connect a wallet to enable Filecoin storage.'}
              {canChat && walletAddr && !isAuthorized && 'Authorize the session key above, then start chatting.'}
              {canChat && walletAddr && isAuthorized && `Using ${llmConfig.model} with Filecoin storage. Send a message.`}
            </p>
            {!canChat && (
              <button onClick={() => setShowSettings(true)}
                className="mt-4 rounded-xl bg-filecoin-600 px-4 py-2 text-xs font-medium text-white hover:bg-filecoin-500 transition-colors">
                Open Settings
              </button>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={msg.role === 'user' ? 'message-bubble-user' : 'message-bubble-agent'}>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{msg.content}</p>
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex justify-start">
            <div className="message-bubble-agent">
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 animate-bounce rounded-full bg-dark-500" style={{ animationDelay: '0ms' }} />
                <span className="h-2 w-2 animate-bounce rounded-full bg-dark-500" style={{ animationDelay: '150ms' }} />
                <span className="h-2 w-2 animate-bounce rounded-full bg-dark-500" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}

        {error && <div className="flex justify-center"><div className="rounded-xl bg-red-900/30 px-4 py-2 text-xs text-red-400">{error}</div></div>}
        <div ref={endRef} />
      </div>

      {/* Input */}
      <div className="input-area">
        <div className="flex w-full items-end gap-2 rounded-2xl border border-dark-800 bg-dark-900 px-4 py-2 focus-within:border-dark-600 transition-colors">
          <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey} placeholder={canChat ? 'Type a message...' : 'Configure API key in Settings'}
            rows={1} disabled={!canChat}
            className="max-h-32 flex-1 resize-none bg-transparent text-sm text-dark-100 placeholder-dark-600 outline-none disabled:opacity-40" />
          <button onClick={handleSend} disabled={!input.trim() || isLoading || !canChat}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-filecoin-600 text-white transition-colors hover:bg-filecoin-500 disabled:opacity-30">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m0 0l-7 7m7-7l7 7" />
            </svg>
          </button>
        </div>
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-md rounded-2xl border border-dark-800 bg-dark-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-dark-800 px-5 py-4">
              <h2 className="text-sm font-semibold text-dark-50">LLM Provider Settings</h2>
              <button onClick={() => setShowSettings(false)} className="rounded-lg p-1 text-dark-500 hover:bg-dark-800 transition-colors">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="space-y-4 px-5 py-5">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-dark-400">Provider URL</label>
                <input type="text" value={draft.providerUrl} onChange={e => setDraft({ ...draft, providerUrl: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                  className="w-full rounded-xl border border-dark-700 bg-dark-850 px-3.5 py-2.5 text-sm text-dark-100 placeholder-dark-600 outline-none focus:border-dark-500" />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-dark-400">API Key</label>
                <div className="relative">
                  <input type={showKey ? 'text' : 'password'} value={draft.apiKey} onChange={e => setDraft({ ...draft, apiKey: e.target.value })}
                    placeholder="sk-..." className="w-full rounded-xl border border-dark-700 bg-dark-850 px-3.5 py-2.5 text-sm text-dark-100 placeholder-dark-600 outline-none focus:border-dark-500 pr-10" />
                  <button type="button" onClick={() => setShowKey(!showKey)} className="absolute right-3 top-1/2 -translate-y-1/2 text-dark-500 hover:text-dark-300">
                    {showKey ? (
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-dark-400">Model</label>
                <input type="text" value={draft.model} onChange={e => setDraft({ ...draft, model: e.target.value })}
                  placeholder="gpt-4o-mini"
                  className="w-full rounded-xl border border-dark-700 bg-dark-850 px-3.5 py-2.5 text-sm text-dark-100 placeholder-dark-600 outline-none focus:border-dark-500" />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-dark-800 px-5 py-4">
              <button onClick={() => setShowSettings(false)} className="rounded-xl px-4 py-2 text-xs font-medium text-dark-400 hover:bg-dark-800 transition-colors">Cancel</button>
              <button onClick={() => {
                const t: LLMConfig = { providerUrl: draft.providerUrl.replace(/\/+$/, '') || 'https://api.openai.com/v1', apiKey: draft.apiKey, model: draft.model || 'gpt-4o-mini' };
                setLlmConfig(t); saveLLMConfig(t); setShowSettings(false); setError(null);
              }} className="rounded-xl bg-filecoin-600 px-5 py-2 text-xs font-medium text-white hover:bg-filecoin-500 transition-colors">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
