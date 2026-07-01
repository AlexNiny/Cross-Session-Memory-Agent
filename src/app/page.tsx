'use client';

import Image from 'next/image';
import { useState, useRef, useEffect, useCallback } from 'react';

type Message = { role: 'user' | 'agent'; content: string };
type StorageLocation = 'Local' | 'Filecoin' | 'Both';
type SessionSummary = { id: string; title: string; count: number; updatedAt: number; storage?: StorageLocation };
type ChatTurn = { turnIndex: number; userMessage: string; agentResponse: string; timestamp: number };
type StorageInfo = {
  type: string;
  filecoinAuthorized: boolean;
  demoMode: boolean;
  memoryLimit: number;
  defaultProviderUrl: string;
  defaultModel: string;
  details: Record<string, string>;
  sessionKeyAddress?: string;
  sessionKeyBalance?: string;
  usdfcBalance?: string;
  storageUsdfcWalletBalance?: string;
  fwssApproved?: boolean;
  estimatedTurns?: number;
  warmStorageAvailable?: boolean;
};
interface LLMConfig { providerUrl: string; apiKey: string; model: string; hasApiKey?: boolean; }

const WALLET_KEY = 'csma_wallet_address';
const SESSION_KEY = 'csma_session_id';
const SESSIONS_KEY = 'csma_sessions';
const BACKUP_EVERY_KEY = 'csma_backup_every';
const CALIBRATION_CHAIN_ID = '0x4CB2F';
const TFIL_FAUCET_URL = 'https://faucet.calibnet.chainsafe-fil.io/funds.html';
const USDFC_FAUCET_URL = 'https://forest-explorer.chainsafe.dev/faucet/calibnet_usdfc';

function makeSessionTitle(messages: Message[]): string {
  const first = messages.find((m) => m.role === 'user')?.content.trim();
  if (!first) return 'New memory thread';
  return first.length > 42 ? `${first.slice(0, 42)}...` : first;
}

function messagesToTurns(messages: Message[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (let index = 0; index < messages.length; index += 2) {
    const user = messages[index];
    const agent = messages[index + 1];
    if (user?.role === 'user' && agent?.role === 'agent') {
      turns.push({
        turnIndex: index / 2,
        userMessage: user.content,
        agentResponse: agent.content,
        timestamp: Date.now(),
      });
    }
  }
  return turns;
}

function countCompleteTurns(messages: Message[]): number {
  return messagesToTurns(messages).length;
}

function mergeCloudTurns(localMessages: Message[], cloudTurns: ChatTurn[]): { messages: Message[]; count: number; updatedAt: number } {
  const byIndex = new Map<number, ChatTurn>();
  for (const turn of cloudTurns) byIndex.set(turn.turnIndex, turn);
  for (const turn of messagesToTurns(localMessages)) byIndex.set(turn.turnIndex, turn);
  const mergedTurns = Array.from(byIndex.values()).sort((a, b) => a.turnIndex - b.turnIndex);
  const updatedAt = Math.max(...mergedTurns.map((turn) => Number(turn.timestamp || 0)), Date.now());
  return {
    messages: turnsToMessages(mergedTurns),
    count: mergedTurns.length,
    updatedAt,
  };
}

function turnsToMessages(turns: ChatTurn[]): Message[] {
  return [...turns]
    .sort((a, b) => a.turnIndex - b.turnIndex)
    .flatMap((turn) => [
      { role: 'user' as const, content: turn.userMessage },
      { role: 'agent' as const, content: turn.agentResponse },
    ]);
}

function readSessions(): SessionSummary[] {
  if (typeof window === 'undefined') return [];
  const byId = new Map<string, SessionSummary>();
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]');
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item?.id) {
          byId.set(item.id, {
            id: item.id,
            title: item.title || 'New memory thread',
            count: Number(item.count || 0),
            updatedAt: Number(item.updatedAt || Date.now()),
            storage: item.storage || 'Local',
          });
        }
      }
    }
  } catch {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith('csma_messages_')) continue;
    const id = key.slice('csma_messages_'.length);
    try {
      const messages = JSON.parse(localStorage.getItem(key) || '[]') as Message[];
      byId.set(id, {
        ...byId.get(id),
        id,
        title: makeSessionTitle(messages),
        count: parseInt(localStorage.getItem(`csma_count_${id}`) || String(Math.floor(messages.length / 2)), 10),
        updatedAt: Number(localStorage.getItem(`csma_updated_${id}`) || Date.now()),
        storage: byId.get(id)?.storage || 'Local',
      });
    } catch {}
  }
  const found = Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(found));
  return found;
}

function readMessagesForSession(id: string): Message[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(`csma_messages_${id}`) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSessions(sessions: SessionSummary[]) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

function createSessionId(): string {
  return crypto.randomUUID();
}

function getInitialSessionId(): string {
  if (typeof window === 'undefined') return '';
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = createSessionId();
    localStorage.setItem(SESSION_KEY, id);
    const sessions = readSessions();
    if (!sessions.some((s) => s.id === id)) {
      saveSessions([{ id, title: 'New memory thread', count: 0, updatedAt: Date.now() }, ...sessions]);
    }
  }
  return id;
}

function loadLLMConfig(d: { providerUrl: string; model: string; hasApiKey?: boolean }): LLMConfig {
  return { providerUrl: d.providerUrl, apiKey: '', model: d.model, hasApiKey: d.hasApiKey };
}

function backupEveryKey(wallet?: string | null): string {
  return wallet ? `${BACKUP_EVERY_KEY}_${wallet.toLowerCase()}` : BACKUP_EVERY_KEY;
}

function readBackupEvery(wallet?: string | null): number {
  if (typeof window === 'undefined') return 5;
  const raw = Number(localStorage.getItem(backupEveryKey(wallet)) || localStorage.getItem(BACKUP_EVERY_KEY) || '5');
  return Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 5;
}

function shorten(a: string) {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

async function detectProvider() {
  const e = (window as any).ethereum;
  if (e?.request) return e;
  try {
    const p = await new Promise<any>((resolve) => {
      const handler = (event: any) => {
        window.removeEventListener('eip6963:announceProvider', handler);
        resolve(event.detail.provider);
      };
      window.addEventListener('eip6963:announceProvider', handler);
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      setTimeout(() => {
        window.removeEventListener('eip6963:announceProvider', handler);
        resolve(null);
      }, 1800);
    });
    return p;
  } catch {
    return null;
  }
}

function StatusDot({ ok, warn }: { ok?: boolean; warn?: boolean }) {
  const color = ok ? 'oklch(0.62 0.15 160)' : warn ? 'oklch(0.72 0.14 78)' : 'oklch(0.68 0.02 215)';
  return <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />;
}

function storageBadgeClass(storage?: StorageLocation) {
  if (storage === 'Both' || storage === 'Filecoin') return 'status-ok';
  return 'status-muted';
}

export default function ChatPage() {
  const [sessionId, setSessionId] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [memoryCount, setMemoryCount] = useState(0);
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [llmConfig, setLlmConfig] = useState<LLMConfig>({ providerUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' });
  const [draft, setDraft] = useState<LLMConfig>({ providerUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' });
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [hasStoredApiKey, setHasStoredApiKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [walletAddr, setWalletAddr] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [backupEvery, setBackupEvery] = useState(5);
  const [backupPendingCount, setBackupPendingCount] = useState(0);
  const [backingUp, setBackingUp] = useState(false);
  const [backingUpAll, setBackingUpAll] = useState(false);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [restoringSession, setRestoringSession] = useState<string | null>(null);

  const endRef = useRef<HTMLDivElement>(null);
  const messageScrollRef = useRef<HTMLElement>(null);
  const bootstrappedRef = useRef(false);
  const restoreAttemptedRef = useRef<Set<string>>(new Set());
  const restoringRef = useRef<Set<string>>(new Set());
  const sessionIdRef = useRef('');

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const applyScroll = () => {
      const scroller = messageScrollRef.current;
      endRef.current?.scrollIntoView({ behavior, block: 'end' });
      if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior });
    };

    requestAnimationFrame(() => {
      applyScroll();
      requestAnimationFrame(applyScroll);
      window.setTimeout(applyScroll, 80);
    });
  }, []);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const refreshSessionList = useCallback((id: string, msgs: Message[], count = Math.floor(msgs.length / 2)) => {
    const now = Date.now();
    setSessions((prev) => {
      const existing = prev.find((s) => s.id === id);
      const next = [{ id, title: makeSessionTitle(msgs), count, updatedAt: now, storage: existing?.storage || 'Local' }, ...prev.filter((s) => s.id !== id)];
      saveSessions(next);
      return next;
    });
    localStorage.setItem(`csma_updated_${id}`, String(now));
  }, []);

  const refreshSessionStorage = useCallback(async () => {
    try {
      const res = await fetch('/api/memory');
      const data = await res.json() as {
        registry?: Record<string, { syncedTurnIndexes?: number[]; pieceCount?: number; createdAt?: number; updatedAt?: number }>;
        localSessions?: Record<string, unknown>;
      };
      const registry = data.registry || {};
      const filecoinIds = new Set(Object.keys(registry));
      const localIds = new Set(Object.keys(data.localSessions || {}));
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith('csma_messages_')) localIds.add(key.slice('csma_messages_'.length));
      }

      setSessions((prev) => {
        const byId = new Map(prev.map((s) => [s.id, s]));
        for (const id of [...filecoinIds, ...localIds]) {
          const current = byId.get(id);
          if (!current) {
            const entry = registry[id];
            const cloudCount = Array.isArray(entry?.syncedTurnIndexes) ? entry.syncedTurnIndexes.length : Number(entry?.pieceCount || 0);
            byId.set(id, {
              id,
              title: 'Memory thread',
              count: parseInt(localStorage.getItem(`csma_count_${id}`) || String(cloudCount), 10),
              updatedAt: Number(localStorage.getItem(`csma_updated_${id}`) || entry?.updatedAt || entry?.createdAt || Date.now()),
            });
          }
        }
        const next = Array.from(byId.values()).map((s) => {
          const hasFilecoin = filecoinIds.has(s.id);
          const hasLocal = localIds.has(s.id);
          const entry = registry[s.id];
          const cloudCount = Array.isArray(entry?.syncedTurnIndexes) ? entry.syncedTurnIndexes.length : Number(entry?.pieceCount || 0);
          const storage: StorageLocation = hasFilecoin && hasLocal ? 'Both' : hasFilecoin ? 'Filecoin' : 'Local';
          return {
            ...s,
            count: Math.max(s.count, cloudCount),
            updatedAt: Math.max(s.updatedAt, Number(entry?.updatedAt || entry?.createdAt || 0)),
            storage,
          };
        }).sort((a, b) => b.updatedAt - a.updatedAt);
        const unchanged = prev.length === next.length && prev.every((item, index) => {
          const candidate = next[index];
          return candidate &&
            item.id === candidate.id &&
            item.title === candidate.title &&
            item.count === candidate.count &&
            item.updatedAt === candidate.updatedAt &&
            item.storage === candidate.storage;
        });
        if (unchanged) return prev;
        saveSessions(next);
        return next;
      });

      const registryEntry = (data.registry || {})[sessionId] as { syncedTurnIndexes?: number[]; pieceCount?: number } | undefined;
      const syncedIndexes = Array.isArray(registryEntry?.syncedTurnIndexes)
        ? new Set(registryEntry.syncedTurnIndexes)
        : new Set(Array.from({ length: Number(registryEntry?.pieceCount || 0) }, (_, index) => index));
      const localMessages = JSON.parse(localStorage.getItem(`csma_messages_${sessionId}`) || '[]') as Message[];
      const localTurnCount = Math.floor(localMessages.length / 2);
      let pending = 0;
      for (let index = 0; index < localTurnCount; index += 1) {
        if (!syncedIndexes.has(index)) pending += 1;
      }
      setBackupPendingCount(pending);
    } catch {}
  }, [sessionId]);

  const persistMessages = useCallback((id: string, msgs: Message[], count?: number) => {
    localStorage.setItem(`csma_messages_${id}`, JSON.stringify(msgs));
    refreshSessionList(id, msgs, count);
  }, [refreshSessionList]);

  const restoreSessionFromCloud = useCallback(async (id: string, options: { silent?: boolean; expectedCount?: number } = {}) => {
    if (!isAuthenticated || restoringRef.current.has(id)) return false;
    const attemptKey = `${id}:${options.expectedCount ?? 'manual'}`;
    if (options.silent && restoreAttemptedRef.current.has(attemptKey)) return false;

    restoringRef.current.add(id);
    restoreAttemptedRef.current.add(attemptKey);
    setRestoringSession(id);
    if (!options.silent) setBackupMessage('Restoring session from cloud...');
    try {
      const res = await fetch(`/api/memory/session?sessionId=${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => ({})) as { turns?: ChatTurn[]; source?: string; error?: string };
      if (!res.ok) throw new Error(data.error || 'Failed to restore session.');
      const turns = Array.isArray(data.turns) ? data.turns : [];
      if (turns.length === 0) {
        if (!options.silent) setBackupMessage('No cloud turns found for this session.');
        return false;
      }

      let localMessages: Message[] = [];
      try {
        localMessages = JSON.parse(localStorage.getItem(`csma_messages_${id}`) || '[]') as Message[];
      } catch {}
      const merged = mergeCloudTurns(localMessages, turns);
      localStorage.setItem(`csma_updated_${id}`, String(merged.updatedAt));
      localStorage.setItem(`csma_count_${id}`, String(merged.count));
      persistMessages(id, merged.messages, merged.count);

      setSessions((prev) => {
        const existing = prev.find((s) => s.id === id);
        const storage: StorageLocation = existing?.storage === 'Filecoin' ? 'Both' : existing?.storage || 'Both';
        const next = [{
          id,
          title: makeSessionTitle(merged.messages),
          count: merged.count,
          updatedAt: merged.updatedAt,
          storage,
        }, ...prev.filter((s) => s.id !== id)];
        saveSessions(next);
        return next;
      });

      if (id === sessionIdRef.current) {
        setMessages(merged.messages);
        setMemoryCount(merged.count);
        scrollToLatest('auto');
      }

      const source = data.source === 'filecoin' ? 'Filecoin' : 'cloud';
      setBackupMessage(`Synced ${turns.length} cloud turn(s) from ${source}.`);
      return true;
    } catch (err) {
      if (!options.silent) setBackupMessage(err instanceof Error ? err.message : 'Cloud restore failed.');
      return false;
    } finally {
      restoringRef.current.delete(id);
      setRestoringSession(null);
    }
  }, [isAuthenticated, persistMessages, scrollToLatest]);

  const loadSession = useCallback((id: string) => {
    localStorage.setItem(SESSION_KEY, id);
    setSessionId(id);
    let loaded: Message[] = [];
    try {
      loaded = JSON.parse(localStorage.getItem(`csma_messages_${id}`) || '[]') as Message[];
      setMessages(loaded);
      setMemoryCount(parseInt(localStorage.getItem(`csma_count_${id}`) || String(Math.floor(loaded.length / 2)), 10));
    } catch {
      setMessages([]);
      setMemoryCount(0);
    }
    setError(null);
    scrollToLatest('auto');
    const summary = sessions.find((s) => s.id === id);
    if (loaded.length === 0 && summary?.storage && summary.storage !== 'Local') {
      void restoreSessionFromCloud(id);
    }
  }, [restoreSessionFromCloud, scrollToLatest, sessions]);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    const initialId = getInitialSessionId();
    const list = readSessions();
    setSessions(list);
    if (!list.some((s) => s.id === initialId)) {
      const next = [{ id: initialId, title: 'New memory thread', count: 0, updatedAt: Date.now() }, ...list];
      setSessions(next);
      saveSessions(next);
    }
    loadSession(initialId);
    fetch('/api/auth/session')
      .then((r) => r.json())
      .then((data) => {
        if (!data.authenticated) {
          setIsAuthenticated(false);
          setWalletAddr(null);
          localStorage.removeItem(WALLET_KEY);
          return;
        }
        setIsAuthenticated(true);
        setWalletAddr(data.user.walletAddress);
        localStorage.setItem(WALLET_KEY, data.user.walletAddress);
        if (data.config) {
          const cfg = loadLLMConfig(data.config);
          setLlmConfig(cfg);
          setDraft(cfg);
          setHasStoredApiKey(Boolean(data.config.hasApiKey));
        }
        refreshSessionStorage();
      })
      .catch(() => {});
    const savedWallet = localStorage.getItem(WALLET_KEY);
    setBackupEvery(readBackupEvery(savedWallet));
    refreshSessionStorage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSession]);

  useEffect(() => {
    setBackupEvery(readBackupEvery(walletAddr));
  }, [walletAddr]);

  useEffect(() => {
    if (sessionId) refreshSessionStorage();
  }, [refreshSessionStorage, sessionId]);

  useEffect(() => {
    if (isAuthenticated) refreshSessionStorage();
  }, [isAuthenticated, refreshSessionStorage]);

  useEffect(() => {
    if (!isAuthenticated || sessions.length === 0) return;
    const current = sessions.find((s) => s.id === sessionId);
    const localTurnCount = countCompleteTurns(readMessagesForSession(sessionId));
    if (localTurnCount > 0 || (current?.storage && current.storage !== 'Local')) return;

    const latestCloudSession = sessions.find((s) => (s.storage === 'Filecoin' || s.storage === 'Both') && s.count > 0);
    if (!latestCloudSession || latestCloudSession.id === sessionId) return;
    loadSession(latestCloudSession.id);
  }, [isAuthenticated, loadSession, sessionId, sessions]);

  useEffect(() => {
    if (!isAuthenticated || !sessionId) return;
    const current = sessions.find((s) => s.id === sessionId);
    if (!current || current.storage === 'Local') return;
    let localMessages: Message[] = [];
    try {
      localMessages = JSON.parse(localStorage.getItem(`csma_messages_${sessionId}`) || '[]') as Message[];
    } catch {}
    const localTurnCount = countCompleteTurns(localMessages);
    if (current.count > localTurnCount) {
      void restoreSessionFromCloud(sessionId, { silent: true, expectedCount: current.count });
    }
  }, [isAuthenticated, restoreSessionFromCloud, sessionId, sessions]);

  useEffect(() => {
    if (!isAuthenticated) {
      setStorageInfo(null);
      return;
    }
    fetch('/api/chat')
      .then((r) => r.json())
      .then((d: StorageInfo) => {
        setStorageInfo(d);
      })
      .catch(() => {});
  }, [isAuthenticated, walletAddr]);

  useEffect(() => {
    scrollToLatest('auto');
  }, [messages, isLoading, sessionId, scrollToLatest]);

  const connectWallet = useCallback(async () => {
    const e = await detectProvider();
    if (!e) { setError('No wallet found. Please install MetaMask.'); return; }
    setConnecting(true);
    setError(null);
    try {
      await e.request({ method: 'eth_requestAccounts' });
      const accounts = await e.request({ method: 'eth_accounts' });
      const addr = accounts?.[0] ? String(accounts[0]) : e.selectedAddress;
      if (!addr) throw new Error('No accounts found. Unlock your wallet and try again.');
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
      setIsAuthenticated(true);
      localStorage.setItem(WALLET_KEY, addr);
      if (verified.config) {
        const cfg = loadLLMConfig(verified.config);
        setLlmConfig(cfg);
        setDraft(cfg);
        setHasStoredApiKey(Boolean(verified.config.hasApiKey));
      } else {
        setHasStoredApiKey(false);
      }
      refreshSessionStorage();
    } catch (err: any) {
      if (err?.code !== 4001) setError(err.message || 'Failed to connect wallet.');
    } finally {
      setConnecting(false);
    }
  }, [refreshSessionStorage]);

  const disconnectWallet = useCallback(() => {
    fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setWalletAddr(null);
    setIsAuthenticated(false);
    setHasStoredApiKey(false);
    setSessions([]);
    setMessages([]);
    setSessionId('');
    setMemoryCount(0);
    setStorageInfo(null);
    setBackupPendingCount(0);
    setBackupMessage(null);
    setRestoringSession(null);
    localStorage.removeItem(WALLET_KEY);
  }, []);

  const authorizeStorage = useCallback(async () => {
    if (!walletAddr) return;
    const e = await detectProvider();
    if (!e) { setError('No wallet found.'); return; }
    setAuthorizing(true);
    setError(null);
    try {
      try {
        await e.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CALIBRATION_CHAIN_ID }] });
      } catch (switchErr: any) {
        if (switchErr.code !== 4902) throw switchErr;
        await e.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: CALIBRATION_CHAIN_ID,
            chainName: 'Filecoin Calibration',
            nativeCurrency: { name: 'tFIL', symbol: 'tFIL', decimals: 18 },
            rpcUrls: ['https://rpc.ankr.com/filecoin_testnet'],
            blockExplorerUrls: ['https://calibration.filscan.io'],
          }],
        });
      }

      const prepRes = await fetch('/api/chat/prepare-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const prep = await prepRes.json();
      if (!prepRes.ok) throw new Error(prep.error);
      if (!prep.alreadyAuthorized) {
        const txHash: string = await e.request({
          method: 'eth_sendTransaction',
          params: [{ from: walletAddr, to: prep.to, data: prep.data, value: prep.suggestedValue }],
        });
        let confirmed = false;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          setBackupMessage(`Waiting for Filecoin authorization confirmation (${attempt + 1}/20)...`);
          const confirmRes = await fetch('/api/chat/confirm-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ txHash }),
          });
          const confirm = await confirmRes.json();
          if (!confirmRes.ok) throw new Error(confirm.error || 'Authorization failed');
          if (confirm.authorized) {
            confirmed = true;
            break;
          }
          if (confirm.error && !confirm.pending) throw new Error(confirm.error);
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
        if (!confirmed) throw new Error('Authorization transaction is still pending. Try checking storage status again in a moment.');
      }
      const infoRes = await fetch('/api/chat');
      setStorageInfo(await infoRes.json());
      setBackupMessage(null);
    } catch (err: any) {
      if (err?.code !== 4001) setError(err.message || 'Authorization failed');
    } finally {
      setAuthorizing(false);
    }
  }, [walletAddr]);

  const createNewSession = useCallback(() => {
    const id = createSessionId();
    const summary = { id, title: 'New memory thread', count: 0, updatedAt: Date.now(), storage: 'Local' as StorageLocation };
    const next = [summary, ...sessions];
    setSessions(next);
    saveSessions(next);
    localStorage.setItem(SESSION_KEY, id);
    setSessionId(id);
    setMessages([]);
    setMemoryCount(0);
    setError(null);
  }, [sessions]);

  const deleteSession = useCallback((id: string) => {
    localStorage.removeItem(`csma_messages_${id}`);
    localStorage.removeItem(`csma_count_${id}`);
    localStorage.removeItem(`csma_updated_${id}`);
    const next = sessions.filter((s) => s.id !== id);
    setSessions(next);
    saveSessions(next);
    if (id === sessionId) {
      if (next[0]) loadSession(next[0].id);
      else createNewSession();
    }
  }, [sessions, sessionId, loadSession, createNewSession]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;
    if (!isAuthenticated) { setError('Sign in with your wallet first.'); return; }
    if (!hasStoredApiKey) { setError('Configure your provider API key first.'); setShowSettings(true); return; }

    const userMsg: Message = { role: 'user', content: text };
    const pending = [...messages, userMsg];
    setMessages(pending);
    persistMessages(sessionId, pending, memoryCount);
    setInput('');
    setError(null);
    setIsLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          message: text,
          backupEvery,
          localTurns: messagesToTurns(messages),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Error ${res.status}`);
      }
      const data = await res.json();
      const final = [...pending, { role: 'agent' as const, content: data.response }];
      setMessages(final);
      setMemoryCount(data.memoryCount);
      localStorage.setItem(`csma_count_${sessionId}`, String(data.memoryCount));
      persistMessages(sessionId, final, data.memoryCount);
      if (data.backup?.uploaded) {
        setBackupMessage(`Auto-backed up ${data.backup.turnIndexes.length} turn(s) to Filecoin.`);
      } else if (data.backup?.queued) {
        setBackupMessage(`Queued ${data.backup.turnIndexes.length} turn(s) for Filecoin backup.`);
      } else if (data.backup?.reason && data.backup.pendingCount > 0) {
        setBackupMessage(`Backup pending: ${data.backup.reason}`);
      }
      if (isAuthenticated) {
        fetch('/api/chat').then((r) => r.json()).then(setStorageInfo).catch(() => {});
      }
      refreshSessionStorage();
    } catch (err: any) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsLoading(false);
    }
  }, [backupEvery, hasStoredApiKey, input, isAuthenticated, isLoading, memoryCount, messages, persistMessages, refreshSessionStorage, sessionId]);

  const updateBackupEvery = useCallback((value: string) => {
    const next = Math.max(1, Math.floor(Number(value) || 1));
    setBackupEvery(next);
    localStorage.setItem(backupEveryKey(walletAddr), String(next));
  }, [walletAddr]);

  const manualBackup = useCallback(async () => {
    if (!walletAddr) { setError('Connect wallet before backing up to Filecoin.'); return; }
    if (!sessionId) return;
    setBackingUp(true);
    setBackupMessage(null);
    setError(null);
    try {
      const storedMessages = readMessagesForSession(sessionId);
      const backupMessages = storedMessages.length > 0 ? storedMessages : messages;
      const res = await fetch('/api/memory/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, turns: messagesToTurns(backupMessages) }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Backup failed');
      const result = data.result;
      if (result.queued) {
        setBackupMessage(`Queued ${result.turnIndexes.length} turn(s) for Filecoin backup.`);
      } else if (result.uploaded) {
        setBackupMessage(`Backed up ${result.turnIndexes.length} turn(s) to Filecoin.`);
      } else {
        setBackupMessage(result.reason || 'No unsynced turns.');
      }
      await refreshSessionStorage();
    } catch (err) {
      setBackupMessage(err instanceof Error ? err.message : 'Backup failed');
    } finally {
      setBackingUp(false);
    }
  }, [messages, refreshSessionStorage, sessionId, walletAddr]);

  const manualBackupAll = useCallback(async () => {
    if (!walletAddr) { setError('Connect wallet before backing up to Filecoin.'); return; }
    setBackingUpAll(true);
    setBackupMessage(null);
    setError(null);
    try {
      const localSessions = readSessions()
        .map((session) => ({
          sessionId: session.id,
          turns: messagesToTurns(readMessagesForSession(session.id)),
        }))
        .filter((session) => session.turns.length > 0);
      const res = await fetch('/api/memory/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true, sessions: localSessions }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Backup failed');
      const results = Array.isArray(data.results) ? data.results : [];
      const uploadedTurns = results.reduce((sum: number, item: any) => sum + (item.uploaded ? item.turnIndexes?.length || 0 : 0), 0);
      const queuedTurns = results.reduce((sum: number, item: any) => sum + (item.queued ? item.turnIndexes?.length || 0 : 0), 0);
      const failed = results.filter((item: any) => item.reason && item.pendingCount > 0 && !item.uploaded && !item.queued).length;
      setBackupMessage(failed > 0
        ? `Queued/backed up ${queuedTurns + uploadedTurns} turn(s). ${failed} session(s) still need attention.`
        : uploadedTurns > 0
          ? `Backed up ${uploadedTurns} turn(s) across local sessions.`
          : queuedTurns > 0
            ? `Queued ${queuedTurns} turn(s) across local sessions for Filecoin backup.`
          : 'No unsynced turns across local sessions.');
      await refreshSessionStorage();
    } catch (err) {
      setBackupMessage(err instanceof Error ? err.message : 'Backup failed');
    } finally {
      setBackingUpAll(false);
    }
  }, [refreshSessionStorage, walletAddr]);

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const saveProviderSettings = useCallback(async () => {
    if (!isAuthenticated) {
      setError('Sign in with your wallet before saving provider settings.');
      return;
    }
    try {
      const res = await fetch('/api/user/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerUrl: draft.providerUrl,
          model: draft.model,
          apiKey: draft.apiKey.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save provider settings.');
      const cfg = loadLLMConfig(data.config);
      setLlmConfig(cfg);
      setDraft(cfg);
      setHasStoredApiKey(Boolean(data.config.hasApiKey));
      setShowSettings(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save provider settings.');
    }
  }, [draft, isAuthenticated]);

  const canChat = isAuthenticated && hasStoredApiKey;
  const isAuthorized = storageInfo?.filecoinAuthorized ?? false;
  const hasUsdfc = Number(storageInfo?.usdfcBalance || '0') > 0;
  const storageReady = isAuthorized && hasUsdfc && !!storageInfo?.fwssApproved;
  const visibleSessions = isAuthenticated ? sessions : [];
  const visibleMessages = isAuthenticated ? messages : [];
  const visibleMemoryCount = isAuthenticated ? memoryCount : 0;
  const currentSession = visibleSessions.find((s) => s.id === sessionId);
  const currentStorage = currentSession?.storage || 'Local';

  return (
    <div className="app-shell">
      <div className="app-window">
      <div className="app-frame">
        <aside className="session-rail flex min-h-0 flex-col border-r border-line bg-[oklch(0.965_0.014_190_/_0.8)]">
          <div className="px-5 pb-4 pt-5">
            <div className="flex items-center gap-3">
              <div className="brand-mark">
                <Image src="/logo.png" alt="Memory Agent logo" width={36} height={36} priority />
              </div>
              <div>
                <h1 className="text-sm font-semibold">Memory Agent</h1>
                <p className="text-xs text-muted">Chatbox with Filecoin memory</p>
              </div>
            </div>
            <button onClick={createNewSession} disabled={!isAuthenticated} className="primary-button mt-5 w-full">
              New session
            </button>
          </div>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 pb-4">
            <div className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Sessions</div>
            {visibleSessions.length === 0 ? (
              <div className="px-2 py-8 text-sm text-muted">No sessions yet.</div>
            ) : (
              <div className="space-y-1.5">
                {visibleSessions.map((s) => (
                  <div key={s.id} className={`group rounded-lg border p-2.5 transition-colors ${s.id === sessionId ? 'border-[var(--accent)] bg-[oklch(0.93_0.055_190)]' : 'border-transparent hover:border-[var(--line)] hover:bg-[oklch(0.985_0.006_190)]'}`}>
                    <button onClick={() => loadSession(s.id)} className="w-full text-left">
                      <div className="line-clamp-2 text-sm font-medium leading-5">{s.title}</div>
                      <div className="mt-2 flex items-center justify-between text-[11px] text-muted">
                        <span>{s.count} turns</span>
                        <span>{new Date(s.updatedAt).toLocaleDateString()}</span>
                      </div>
                      <div className="mt-2">
                        <span className={`status-pill ${restoringSession === s.id ? 'status-warn' : storageBadgeClass(s.storage)}`}>
                          <StatusDot ok={s.storage === 'Both' || s.storage === 'Filecoin'} warn={restoringSession === s.id} />
                          {restoringSession === s.id ? 'Restoring' : s.storage || 'Local'}
                        </span>
                      </div>
                    </button>
                    <button onClick={() => deleteSession(s.id)} className="mt-2 hidden text-[11px] font-medium text-[var(--danger)] group-hover:inline-flex">
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-line p-4">
            {walletAddr ? (
              <button onClick={disconnectWallet} className="secondary-button w-full">
                <StatusDot ok={isAuthenticated} warn={!isAuthenticated} />
                {shorten(walletAddr)}
              </button>
            ) : (
              <button onClick={connectWallet} disabled={connecting} className="secondary-button w-full">
                {connecting ? 'Connecting...' : 'Connect wallet'}
              </button>
            )}
          </div>
        </aside>

        <main className="flex min-h-0 flex-col">
          <header className="flex items-center justify-between border-b border-line bg-[oklch(0.99_0.006_190_/_0.76)] px-6 py-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">{isAuthenticated ? currentSession?.title || 'New memory thread' : 'Signed out'}</span>
                {isAuthenticated && sessionId && <span className="status-pill status-muted">{sessionId.slice(0, 8)}</span>}
                {isAuthenticated && (
                  <span className={`status-pill ${storageBadgeClass(currentStorage)}`}>
                    <StatusDot ok={currentStorage === 'Both' || currentStorage === 'Filecoin'} />
                    {currentStorage}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted">{visibleMemoryCount} remembered turns, context limit {storageInfo?.memoryLimit ?? 10}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`status-pill ${canChat ? 'status-ok' : 'status-warn'}`}>
                <StatusDot ok={canChat} warn={!canChat} />
                {canChat ? llmConfig.model : 'Provider needed'}
              </span>
              <a href="/memory" className="secondary-button">Memory</a>
              <a href="/profile" className="secondary-button">Profile</a>
              <button onClick={() => setShowSettings(true)} className="secondary-button">Settings</button>
            </div>
          </header>

          {!walletAddr && (
            <div className="border-b border-line bg-[var(--warn-soft)] px-6 py-3 text-sm text-[oklch(0.45_0.11_72)]">
              Sign in with your wallet before configuring a provider or chatting.
            </div>
          )}
          {walletAddr && !isAuthorized && (
            <div className="flex items-center justify-between gap-3 border-b border-line bg-[var(--warn-soft)] px-6 py-3">
              <div>
                <p className="text-sm font-semibold text-[oklch(0.43_0.11_72)]">Session key authorization is needed for Filecoin storage.</p>
                <p className="text-xs text-[oklch(0.48_0.07_72)]">This creates the storage account used for quiet memory writes.</p>
              </div>
              <button onClick={authorizeStorage} disabled={authorizing} className="primary-button">
                {authorizing ? 'Authorizing...' : 'Authorize storage'}
              </button>
            </div>
          )}
          {walletAddr && isAuthorized && !hasUsdfc && (
            <div className="flex items-center justify-between gap-3 border-b border-line bg-[var(--warn-soft)] px-6 py-3 text-sm text-[oklch(0.43_0.11_72)]">
              <span>Filecoin storage needs Calibration test funds before uploads can run reliably.</span>
              <div className="flex flex-wrap items-center gap-2">
                <a href={TFIL_FAUCET_URL} target="_blank" rel="noreferrer" className="secondary-button">Get tFIL</a>
                <a href={USDFC_FAUCET_URL} target="_blank" rel="noreferrer" className="secondary-button">Get USDFC</a>
                <a href="/profile" className="secondary-button">Fund storage</a>
              </div>
            </div>
          )}

          <section ref={messageScrollRef} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6 py-6">
            {isAuthenticated && restoringSession === sessionId ? (
              <div className="flex h-full items-center justify-center text-sm text-muted">
                <span className="mr-2 h-2 w-2 animate-pulse rounded-full bg-[var(--accent)]" />
                Restoring conversation from cloud
              </div>
            ) : visibleMessages.length === 0 && !isLoading ? (
              <div className="mx-auto flex h-full max-w-2xl flex-col justify-center">
                <div className="panel rounded-lg p-8">
                  <div className="mb-5 inline-flex rounded-full bg-[var(--accent-soft)] px-3 py-1 text-xs font-semibold text-[var(--accent-strong)]">
                    Persistent chat memory
                  </div>
                  <h2 className="text-2xl font-semibold tracking-[-0.01em]">Start a conversation that can survive the tab.</h2>
                  <p className="mt-3 max-w-[65ch] text-sm leading-6 text-muted">
                    Each turn is kept locally first, then written to Filecoin when your storage account is funded and approved.
                  </p>
                  <div className="mt-6 grid gap-3 sm:grid-cols-3">
                    <div className="soft-panel rounded-lg p-3">
                      <div className="text-xs font-semibold">1. Chat</div>
                      <p className="mt-1 text-xs leading-5 text-muted">Ask naturally, the agent injects prior turns into context.</p>
                    </div>
                    <div className="soft-panel rounded-lg p-3">
                      <div className="text-xs font-semibold">2. Store</div>
                      <p className="mt-1 text-xs leading-5 text-muted">Session-key writes keep wallet prompts out of the loop.</p>
                    </div>
                    <div className="soft-panel rounded-lg p-3">
                      <div className="text-xs font-semibold">3. Return</div>
                      <p className="mt-1 text-xs leading-5 text-muted">Switch sessions and recover conversation memory.</p>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mx-auto flex max-w-4xl flex-col gap-4">
                {visibleMessages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={msg.role === 'user' ? 'message-user' : 'message-agent'}>
                      <p className="whitespace-pre-wrap text-sm leading-6">{msg.content}</p>
                    </div>
                  </div>
                ))}
                {isLoading && (
                  <div className="flex justify-start">
                    <div className="message-agent">
                      <div className="flex items-center gap-2 text-sm text-muted">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--accent)]" />
                        Thinking and preparing memory write
                      </div>
                    </div>
                  </div>
                )}
                {error && (
                  <div className="rounded-lg border border-[oklch(0.82_0.07_28)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]">
                    {error}
                  </div>
                )}
                <div ref={endRef} />
              </div>
            )}
          </section>

          <footer className="border-t border-line bg-[oklch(0.99_0.006_190_/_0.9)] px-6 py-4">
            <div className="mx-auto max-w-4xl">
              <div className="panel flex items-end gap-3 rounded-lg p-3">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKey}
                  rows={1}
	                  disabled={!canChat}
	                  placeholder={canChat ? 'Ask anything, memory will follow the session...' : 'Sign in and configure your provider first'}
                  className="min-h-[2.75rem] max-h-36 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-6 outline-none placeholder:text-faint disabled:opacity-50"
                />
                <button onClick={handleSend} disabled={!input.trim() || isLoading || !canChat} className="primary-button h-11 px-5">
                  Send
                </button>
              </div>
            </div>
          </footer>
        </main>

        <aside className="storage-rail min-h-0 border-l border-line bg-[oklch(0.965_0.014_190_/_0.72)] px-4 py-3">
          <div className="storage-rail-header">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-faint">Storage</div>
            <h2 className="mt-1 text-base font-semibold">Memory storage</h2>
          </div>
          <div className="storage-stack">
            <div className="soft-panel storage-panel rounded-lg">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Backend</span>
                <span className={`status-pill ${storageReady ? 'status-ok' : isAuthorized ? 'status-warn' : 'status-muted'}`}>
                  <StatusDot ok={storageReady} warn={isAuthorized && !storageReady} />
                  {storageReady ? 'Ready' : isAuthorized ? 'Needs funds' : 'Local'}
                </span>
              </div>
              <div className="storage-metrics mt-3 text-sm">
                <div className="flex justify-between gap-3"><span className="text-muted">tFIL gas</span><span className="font-medium">{Number(storageInfo?.sessionKeyBalance || 0).toFixed(4)}</span></div>
                <div className="flex justify-between gap-3"><span className="text-muted">USDFC Pay</span><span className="font-medium">{Number(storageInfo?.usdfcBalance || 0).toFixed(4)}</span></div>
                <div className="flex justify-between gap-3"><span className="text-muted">USDFC Wallet</span><span className="font-medium">{Number(storageInfo?.storageUsdfcWalletBalance || 0).toFixed(4)}</span></div>
                <div className="flex justify-between gap-3"><span className="text-muted">Warm approval</span><span className="font-medium">{storageInfo?.fwssApproved ? 'Approved' : 'Pending'}</span></div>
              </div>
            </div>

            <div className="soft-panel storage-panel rounded-lg">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium">Backup cadence</div>
                  <p className="mt-0.5 text-xs leading-5 text-muted">Auto backup after local turns.</p>
                </div>
                <span className={`status-pill ${backupPendingCount > 0 ? 'status-warn' : 'status-ok'}`}>
                  <StatusDot ok={backupPendingCount === 0} warn={backupPendingCount > 0} />
                  {backupPendingCount} pending
                </span>
              </div>
              <label className="mt-3 flex items-center justify-between gap-3">
                <span className="text-xs font-semibold text-muted">Turns per backup</span>
                <input
                  className="field storage-stepper px-3 py-2 text-sm"
                  type="number"
                  min={1}
                  step={1}
                  value={backupEvery}
                  onChange={(e) => updateBackupEvery(e.target.value)}
                />
              </label>
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-3)]">
                  <div
                    className="h-full rounded-full bg-[var(--accent-strong)] transition-all"
                    style={{ width: `${Math.min(100, (backupPendingCount / Math.max(1, backupEvery)) * 100)}%` }}
                  />
                </div>
                <span className="text-xs font-medium text-muted">/{backupEvery}</span>
              </div>
              <button
                onClick={manualBackup}
                disabled={!walletAddr || backingUp || backingUpAll || backupPendingCount === 0}
                className="primary-button storage-action mt-3 w-full"
              >
                {backingUp ? 'Queueing...' : 'Backup now'}
              </button>
              <button
                onClick={manualBackupAll}
                disabled={!walletAddr || backingUp || backingUpAll}
                className="secondary-button storage-action mt-2 w-full"
              >
                {backingUpAll ? 'Backing up...' : 'Backup all'}
              </button>
              {backupMessage && (
                <div className="mt-2 rounded-lg border border-line bg-[oklch(0.99_0.006_190)] px-3 py-2 text-xs leading-5 text-muted">
                  {backupMessage}
                </div>
              )}
            </div>

            <div className="soft-panel storage-panel rounded-lg">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium">Provider</div>
                <span className={`status-pill ${hasStoredApiKey ? 'status-ok' : 'status-warn'}`}>
                  <StatusDot ok={hasStoredApiKey} warn={!hasStoredApiKey} />
                  {hasStoredApiKey ? 'Saved' : 'Missing'}
                </span>
              </div>
              <div className="mt-2 truncate text-xs leading-5 text-muted" title={llmConfig.providerUrl || 'https://api.openai.com/v1'}>
                {llmConfig.providerUrl || 'https://api.openai.com/v1'}
              </div>
              <button onClick={() => setShowSettings(true)} className="secondary-button storage-action mt-3 w-full">Edit provider</button>
            </div>

            <div className="storage-links grid grid-cols-2 gap-2">
              <a href="/memory" className="secondary-button storage-action w-full">Memory</a>
              <a href="/profile" className="secondary-button storage-action w-full">Profile</a>
            </div>
          </div>
        </aside>
      </div>

      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[oklch(0.28_0.03_215_/_0.36)] px-4">
          <div className="panel w-full max-w-lg rounded-lg">
            <div className="flex items-center justify-between border-b border-line px-6 py-4">
              <div>
                <h2 className="text-base font-semibold">Provider settings</h2>
                <p className="mt-1 text-xs text-muted">OpenAI-compatible endpoint and model.</p>
              </div>
              <button onClick={() => setShowSettings(false)} className="icon-button" aria-label="Close settings">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="space-y-4 px-6 py-5">
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-muted">Provider URL</span>
                <input className="field px-3.5 py-2.5 text-sm" value={draft.providerUrl} onChange={(e) => setDraft({ ...draft, providerUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
              </label>
              <label className="block">
	                <span className="mb-1.5 block text-xs font-semibold text-muted">API Key</span>
                <div className="relative">
	                  <input className="field px-3.5 py-2.5 pr-12 text-sm" type={showKey ? 'text' : 'password'} value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} placeholder={hasStoredApiKey ? 'Leave blank to keep saved key' : 'sk-...'} />
                  <button className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-semibold text-muted hover:bg-[var(--surface-3)]" onClick={() => setShowKey(!showKey)} type="button">
                    {showKey ? 'Hide' : 'Show'}
                  </button>
                </div>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-muted">Model</span>
                <input className="field px-3.5 py-2.5 text-sm" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="gpt-4o-mini" />
              </label>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-line px-6 py-4">
              <button onClick={() => setShowSettings(false)} className="secondary-button">Cancel</button>
	              <button onClick={saveProviderSettings} className="primary-button">Save</button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
