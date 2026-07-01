'use client';

import Image from 'next/image';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';

interface ChatTurn {
  turnIndex: number;
  userMessage: string;
  agentResponse: string;
  timestamp: number;
}

interface BackupBatch {
  pieceCid: string;
  turnIndexes: number[];
  createdAt: number;
}

interface SessionEntry {
  sessionId: string;
  turnCount: number;
  storage: 'Filecoin' | 'Local' | 'Both';
  datasetId?: string;
  providerAddress?: string;
  lastPieceCid?: string;
  createdAt?: number;
  updatedAt?: number;
  backups: BackupBatch[];
  turns: ChatTurn[];
}

function turnsToMessages(turns: ChatTurn[]) {
  return [...turns]
    .sort((a, b) => a.turnIndex - b.turnIndex)
    .flatMap((turn) => [
      { role: 'user' as const, content: turn.userMessage },
      { role: 'agent' as const, content: turn.agentResponse },
    ]);
}

function makeSessionTitle(messages: Array<{ role: 'user' | 'agent'; content: string }>): string {
  const first = messages.find((message) => message.role === 'user')?.content.trim();
  if (!first) return 'Memory thread';
  return first.length > 42 ? `${first.slice(0, 42)}...` : first;
}

function formatTime(ts?: number): string {
  if (!ts) return 'No timestamp';
  return new Date(ts).toLocaleString();
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function shortCid(cid?: string): string {
  if (!cid) return 'No CID';
  return cid.length > 22 ? `${cid.slice(0, 12)}...${cid.slice(-8)}` : cid;
}

function formatTurns(turnIndexes: number[]): string {
  if (turnIndexes.length === 0) return 'No turns';
  const sorted = [...turnIndexes].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const index of sorted.slice(1)) {
    if (index === prev + 1) {
      prev = index;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = index;
    prev = index;
  }
  ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return `Turn ${ranges.join(', ')}`;
}

function storageClass(storage: SessionEntry['storage']) {
  return storage === 'Local' ? 'status-muted' : 'status-ok';
}

export default function MemoryPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);

  const loadMemory = useCallback(() => {
    setLoading(true);
    fetch('/api/memory')
      .then(r => r.json())
      .then((server: {
        registry: Record<string, {
          datasetId?: string;
          providerAddress?: string;
          lastPieceCid?: string;
          createdAt?: number;
          updatedAt?: number;
          pieceCount?: number;
          batches?: BackupBatch[];
        }>;
        localSessions?: Record<string, { turnCount?: number; updatedAt?: number }>;
      }) => {
        const registry = server.registry || {};
        const merged: Record<string, SessionEntry> = {};

        for (const [sid, info] of Object.entries(registry)) {
          merged[sid] = {
            sessionId: sid,
            turnCount: (info as any).pieceCount || 0,
            storage: 'Filecoin',
            datasetId: (info as any).datasetId,
            providerAddress: (info as any).providerAddress,
            lastPieceCid: (info as any).lastPieceCid,
            createdAt: (info as any).createdAt,
            updatedAt: (info as any).updatedAt,
            backups: Array.isArray((info as any).batches) ? (info as any).batches : [],
            turns: [],
          };
        }

        for (const [sid, info] of Object.entries(server.localSessions || {})) {
          if (merged[sid]) {
            merged[sid].turnCount = Math.max(merged[sid].turnCount, Number(info.turnCount || 0));
            merged[sid].createdAt = merged[sid].createdAt || info.updatedAt;
            merged[sid].storage = 'Both';
          } else {
            merged[sid] = {
              sessionId: sid,
              turnCount: Number(info.turnCount || 0),
              storage: 'Local',
              createdAt: info.updatedAt,
              updatedAt: info.updatedAt,
              backups: [],
              turns: [],
            };
          }
        }

        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key?.startsWith('csma_messages_')) continue;
          const sid = key.slice('csma_messages_'.length);
          try {
            const msgs = JSON.parse(localStorage.getItem(key) || '[]');
            const turns: ChatTurn[] = [];
            for (let j = 0; j < msgs.length; j += 2) {
              if (msgs[j]?.role === 'user' && msgs[j + 1]?.role === 'agent') {
                turns.push({
                  turnIndex: j / 2,
                  userMessage: msgs[j].content,
                  agentResponse: msgs[j + 1].content,
                  timestamp: Number(localStorage.getItem(`csma_updated_${sid}`) || 0),
                });
              }
            }
            const turnCount = parseInt(localStorage.getItem(`csma_count_${sid}`) || String(turns.length), 10);
            if (merged[sid]) {
              merged[sid].turns = turns;
              merged[sid].turnCount = Math.max(merged[sid].turnCount, turnCount);
              merged[sid].storage = merged[sid].storage === 'Filecoin' ? 'Both' : merged[sid].storage;
            } else {
              merged[sid] = {
                sessionId: sid,
                turnCount,
                storage: 'Local',
                backups: [],
                turns,
              };
            }
          } catch {}
        }

        const list = Object.values(merged).sort((a, b) => (b.createdAt || b.turns[0]?.timestamp || 0) - (a.createdAt || a.turns[0]?.timestamp || 0));
        setSessions(list);
        setSelected((current) => current && list.some((s) => s.sessionId === current) ? current : list[0]?.sessionId || null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadMemory();
  }, [loadMemory]);

  const deleteLocalSession = useCallback((sessionId: string) => {
    localStorage.removeItem(`csma_messages_${sessionId}`);
    localStorage.removeItem(`csma_count_${sessionId}`);
    localStorage.removeItem(`csma_updated_${sessionId}`);
    try {
      const sessions = JSON.parse(localStorage.getItem('csma_sessions') || '[]').filter((s: any) => s.id !== sessionId);
      localStorage.setItem('csma_sessions', JSON.stringify(sessions));
    } catch {}
    setSessions((prev) => {
      const target = prev.find((s) => s.sessionId === sessionId);
      return target?.storage === 'Both'
        ? prev.map((s) => s.sessionId === sessionId ? { ...s, storage: 'Filecoin' as const, turns: [] } : s)
        : prev.filter((s) => s.sessionId !== sessionId);
    });
  }, []);

  const restoreLocalCopy = useCallback(async (sessionId: string) => {
    setRestoring(sessionId);
    setRestoreMessage(null);
    try {
      const res = await fetch(`/api/memory/session?sessionId=${encodeURIComponent(sessionId)}`);
      const data = await res.json().catch(() => ({})) as { turns?: ChatTurn[]; source?: string; error?: string };
      if (!res.ok) throw new Error(data.error || 'Failed to restore session.');
      const turns = Array.isArray(data.turns) ? data.turns : [];
      if (turns.length === 0) {
        setRestoreMessage('No cloud turns found for this session.');
        return;
      }

      const messages = turnsToMessages(turns);
      const updatedAt = Math.max(...turns.map((turn) => Number(turn.timestamp || 0)), Date.now());
      localStorage.setItem(`csma_messages_${sessionId}`, JSON.stringify(messages));
      localStorage.setItem(`csma_count_${sessionId}`, String(turns.length));
      localStorage.setItem(`csma_updated_${sessionId}`, String(updatedAt));
      try {
        const existing = JSON.parse(localStorage.getItem('csma_sessions') || '[]');
        const sessions = Array.isArray(existing) ? existing : [];
        const next = [{
          id: sessionId,
          title: makeSessionTitle(messages),
          count: turns.length,
          updatedAt,
          storage: 'Both',
        }, ...sessions.filter((session: any) => session?.id !== sessionId)];
        localStorage.setItem('csma_sessions', JSON.stringify(next));
      } catch {}
      setSessions((prev) => prev.map((session) => session.sessionId === sessionId
        ? {
            ...session,
            storage: session.storage === 'Filecoin' ? 'Both' : session.storage,
            turnCount: Math.max(session.turnCount, turns.length),
            updatedAt,
            turns,
          }
        : session));
      setRestoreMessage(`Restored ${turns.length} turn(s) from ${data.source === 'filecoin' ? 'Filecoin' : 'cloud'}.`);
    } catch (err) {
      setRestoreMessage(err instanceof Error ? err.message : 'Restore failed.');
    } finally {
      setRestoring(null);
    }
  }, []);

  const selectedSession = sessions.find(s => s.sessionId === selected);
  const filecoinCount = sessions.filter((s) => s.storage !== 'Local').length;
  const latestBackup = selectedSession?.backups[selectedSession.backups.length - 1];
  const latestPieceCid = selectedSession?.lastPieceCid || latestBackup?.pieceCid;
  const backupPieceCount = selectedSession ? selectedSession.backups.length || (latestPieceCid ? 1 : 0) : 0;

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
              <h1 className="text-base font-semibold">Memory Explorer</h1>
              <p className="text-xs text-muted">{sessions.length} sessions, {filecoinCount} Filecoin-backed</p>
            </div>
          </div>
          <button onClick={loadMemory} className="secondary-button">Refresh</button>
        </header>

        {loading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted">Loading memory index...</div>
        ) : sessions.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-6">
            <div className="panel max-w-md rounded-lg p-8 text-center">
              <h2 className="text-lg font-semibold">No memory yet</h2>
              <p className="mt-2 text-sm leading-6 text-muted">Start a chat session and saved turns will appear here.</p>
              <button onClick={() => router.push('/')} className="primary-button mt-5">Back to chat</button>
            </div>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)] overflow-hidden max-[860px]:flex max-[860px]:flex-col">
            <aside className="scrollbar-thin overflow-y-auto border-r border-line bg-[oklch(0.965_0.014_190_/_0.75)] p-4 max-[860px]:max-h-80 max-[860px]:border-b max-[860px]:border-r-0">
              <div className="space-y-2">
                {sessions.map((s) => (
                  <div key={s.sessionId} className={`rounded-lg border p-3 transition-colors ${selected === s.sessionId ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-transparent hover:border-[var(--line)] hover:bg-[oklch(0.99_0.006_190)]'}`}>
                    <button onClick={() => setSelected(s.sessionId)} className="w-full text-left">
                      <div className="flex items-center justify-between gap-3">
                        <code className="text-xs font-semibold">{shortId(s.sessionId)}</code>
                        <span className={`status-pill ${storageClass(s.storage)}`}>{s.storage}</span>
                      </div>
                      <div className="mt-3 flex items-center justify-between text-xs text-muted">
                        <span>{s.turnCount} turns</span>
                        <span>{formatTime(s.createdAt)}</span>
                      </div>
                    </button>
                    {s.storage !== 'Filecoin' && (
                      <button onClick={() => deleteLocalSession(s.sessionId)} className="mt-3 text-xs font-semibold text-[var(--danger)]">
                        Delete local copy
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </aside>

            <main className="scrollbar-thin overflow-y-auto p-6">
              {!selectedSession ? (
                <div className="flex h-full items-center justify-center text-sm text-muted">Select a session to inspect memory.</div>
              ) : (
                <div className="mx-auto max-w-4xl">
                  <div className="panel rounded-lg p-5">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-faint">Session</div>
                        <code className="mt-2 block break-all text-sm font-semibold">{selectedSession.sessionId}</code>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {selectedSession.storage !== 'Local' && (
                          <button
                            onClick={() => restoreLocalCopy(selectedSession.sessionId)}
                            disabled={restoring === selectedSession.sessionId}
                            className="secondary-button"
                          >
                            {restoring === selectedSession.sessionId ? 'Restoring...' : 'Restore local copy'}
                          </button>
                        )}
                        <span className={`status-pill ${storageClass(selectedSession.storage)}`}>{selectedSession.storage}</span>
                      </div>
                    </div>
                    {restoreMessage && <div className="mt-4 rounded-lg border border-line bg-[oklch(0.99_0.006_190)] px-3 py-2 text-xs text-muted">{restoreMessage}</div>}
                    <div className="mt-5 grid gap-3 sm:grid-cols-3">
                      <div className="soft-panel rounded-lg p-3"><div className="text-xs text-muted">Turns</div><div className="mt-1 text-lg font-semibold">{selectedSession.turnCount}</div></div>
                      <div className="soft-panel rounded-lg p-3"><div className="text-xs text-muted">Created</div><div className="mt-1 text-sm font-semibold">{formatTime(selectedSession.createdAt)}</div></div>
                      <div className="soft-panel rounded-lg p-3"><div className="text-xs text-muted">Dataset</div><div className="mt-1 truncate text-sm font-semibold">{selectedSession.datasetId || 'Local only'}</div></div>
                    </div>
                  </div>

                  <div className="mt-5 panel rounded-lg p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-faint">Filecoin backups</div>
                        <h2 className="mt-1 text-base font-semibold">Backup CIDs</h2>
                      </div>
                      <span className={`status-pill ${latestPieceCid ? 'status-ok' : 'status-muted'}`}>
                        {backupPieceCount} piece{backupPieceCount === 1 ? '' : 's'}
                      </span>
                    </div>

                    <div className="mt-4 soft-panel rounded-lg p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-muted">Latest backup CID</span>
                        <span className="text-xs text-muted">{formatTime(latestBackup?.createdAt || selectedSession.updatedAt)}</span>
                      </div>
                      <code className="mt-2 block break-all text-sm font-semibold">
                        {latestPieceCid || 'No Filecoin backup yet'}
                      </code>
                    </div>

                    {selectedSession.backups.length > 0 ? (
                      <div className="mt-3 divide-y divide-[var(--line)] overflow-hidden rounded-lg border border-line">
                        {[...selectedSession.backups].reverse().map((backup, index) => (
                          <div key={`${backup.pieceCid}-${backup.createdAt}-${index}`} className="grid gap-2 bg-[oklch(0.99_0.006_190)] p-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-xs font-semibold">{formatTurns(backup.turnIndexes || [])}</span>
                                {index === 0 && <span className="status-pill status-ok">Latest</span>}
                              </div>
                              <code className="mt-1 block truncate text-xs text-muted" title={backup.pieceCid}>
                                {shortCid(backup.pieceCid)}
                              </code>
                            </div>
                            <div className="text-left text-xs text-muted sm:text-right">{formatTime(backup.createdAt)}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-3 rounded-lg border border-line bg-[oklch(0.99_0.006_190)] p-4 text-sm text-muted">
                        No Filecoin backup history for this session.
                      </div>
                    )}
                  </div>

                  <div className="mt-5 space-y-5">
                    {selectedSession.turns.length === 0 ? (
                      <div className="soft-panel rounded-lg p-8 text-center text-sm text-muted">No local turn payload available for this session.</div>
                    ) : selectedSession.turns.map((turn) => (
                      <section key={turn.turnIndex} className="space-y-3">
                        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-faint">Turn {turn.turnIndex}</div>
                        <div className="flex justify-end"><div className="message-user"><p className="whitespace-pre-wrap text-sm leading-6">{turn.userMessage}</p></div></div>
                        <div className="flex justify-start"><div className="message-agent"><p className="whitespace-pre-wrap text-sm leading-6">{turn.agentResponse}</p></div></div>
                      </section>
                    ))}
                  </div>
                </div>
              )}
            </main>
          </div>
        )}
      </div>
    </div>
  );
}
