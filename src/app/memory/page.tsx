'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';

interface ChatTurn {
  turnIndex: number;
  userMessage: string;
  agentResponse: string;
  timestamp: number;
}

interface SessionEntry {
  sessionId: string;
  turnCount: number;
  storage: 'Filecoin' | 'Local' | 'Both';
  datasetId?: string;
  providerAddress?: string;
  createdAt?: number;
  turns: ChatTurn[];
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString();
}

function shortId(id: string): string {
  return id.slice(0, 8) + '...';
}

export default function MemoryPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch server-side data (Filecoin registry + local memory backup)
    fetch('/api/memory')
      .then(r => r.json())
      .then((server: { registry: Record<string, any>; localMemory: Record<string, ChatTurn[]> }) => {
        const merged: Record<string, SessionEntry> = {};

        // Process Filecoin registry entries
        for (const [sid, info] of Object.entries(server.registry)) {
          merged[sid] = {
            sessionId: sid,
            turnCount: (info as any).pieceCount || 0,
            storage: 'Filecoin',
            datasetId: (info as any).datasetId,
            providerAddress: (info as any).providerAddress,
            createdAt: (info as any).createdAt,
            turns: [],
          };
        }

        // Process local memory backup entries
        for (const [sid, turns] of Object.entries(server.localMemory)) {
          if (merged[sid]) {
            merged[sid].turns = turns as ChatTurn[];
            merged[sid].turnCount = Math.max(merged[sid].turnCount, (turns as ChatTurn[]).length);
            merged[sid].storage = 'Both';
          } else {
            merged[sid] = {
              sessionId: sid,
              turnCount: (turns as ChatTurn[]).length,
              storage: 'Local',
              turns: turns as ChatTurn[],
            };
          }
        }

        // Scan localStorage for additional sessions
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith('csma_messages_')) {
            const sid = key.slice('csma_messages_'.length);
            if (!merged[sid]) {
              try {
                const msgs = JSON.parse(localStorage.getItem(key) || '[]');
                const count = parseInt(localStorage.getItem(`csma_count_${sid}`) || String(msgs.length), 10);
                merged[sid] = {
                  sessionId: sid,
                  turnCount: count,
                  storage: 'Local' as const,
                  turns: [],
                };
                // Try to reconstruct turns from the flat message array
                const reconstructed: ChatTurn[] = [];
                for (let j = 0; j < msgs.length; j += 2) {
                  if (msgs[j]?.role === 'user' && msgs[j + 1]?.role === 'agent') {
                    reconstructed.push({
                      turnIndex: j / 2,
                      userMessage: msgs[j].content,
                      agentResponse: msgs[j + 1].content,
                      timestamp: 0,
                    });
                  }
                }
                if (reconstructed.length > 0) merged[sid].turns = reconstructed;
              } catch {}
            }
          }
        }

        const list = Object.values(merged).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        setSessions(list);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const selectedSession = sessions.find(s => s.sessionId === selected);

  return (
    <div className="mx-auto flex h-screen max-w-6xl flex-col bg-dark-950 text-dark-50">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-dark-800 px-4 py-3">
        <div className="flex items-center gap-3">
          <button onClick={() => router.push('/')}
            className="rounded-lg p-2 text-dark-500 hover:bg-dark-800 hover:text-dark-300 transition-colors">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </button>
          <div>
            <h1 className="text-sm font-semibold">Memory Explorer</h1>
            <p className="text-xs text-dark-500">Browse all stored conversations</p>
          </div>
        </div>
        <span className="text-xs text-dark-500">{sessions.length} sessions</span>
      </header>

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 animate-bounce rounded-full bg-dark-500" style={{ animationDelay: '0ms' }} />
            <span className="h-2 w-2 animate-bounce rounded-full bg-dark-500" style={{ animationDelay: '150ms' }} />
            <span className="h-2 w-2 animate-bounce rounded-full bg-dark-500" style={{ animationDelay: '300ms' }} />
          </div>
        </div>
      ) : sessions.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center text-dark-500">
          <svg className="mb-4 h-12 w-12 text-dark-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
          <p className="text-sm font-medium">No memory data found</p>
          <p className="mt-1 text-xs">Start a conversation on the main page to create memories.</p>
          <button onClick={() => router.push('/')}
            className="mt-4 rounded-xl bg-filecoin-600 px-4 py-2 text-xs font-medium text-white hover:bg-filecoin-500 transition-colors">
            Back to Chat
          </button>
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* Session list */}
          <div className="scrollbar-thin w-64 shrink-0 overflow-y-auto border-r border-dark-800">
            {sessions.map(s => (
              <button key={s.sessionId} onClick={() => setSelected(s.sessionId)}
                className={`w-full border-b border-dark-800/50 px-4 py-3 text-left transition-colors hover:bg-dark-800/50 ${selected === s.sessionId ? 'bg-dark-800' : ''}`}>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono text-dark-300">{shortId(s.sessionId)}</span>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                    s.storage === 'Filecoin' ? 'bg-filecoin-600/20 text-filecoin-400' :
                    s.storage === 'Both' ? 'bg-filecoin-600/20 text-filecoin-400' :
                    'bg-dark-700/50 text-dark-400'
                  }`}>{s.storage}</span>
                </div>
                <div className="mt-1 flex items-center gap-3 text-[11px] text-dark-500">
                  <span>{s.turnCount} turns</span>
                  {s.datasetId && <span title={`Dataset ID: ${s.datasetId}`}>📦</span>}
                </div>
                {s.createdAt && (
                  <div className="mt-0.5 text-[10px] text-dark-600">{formatTime(s.createdAt)}</div>
                )}
              </button>
            ))}
          </div>

          {/* Selected session messages */}
          <div className="scrollbar-thin flex-1 overflow-y-auto p-4">
            {!selectedSession ? (
              <div className="flex h-full items-center justify-center text-dark-500">
                <p className="text-sm">Select a session to view its memory</p>
              </div>
            ) : selectedSession.turns.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-dark-500">
                <p className="text-sm">No turn data for this session</p>
                <p className="mt-1 text-xs">Dataset ID: {selectedSession.datasetId || 'N/A'}</p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-xl bg-dark-900 px-4 py-3 text-xs text-dark-400">
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    <span>Session: <code className="text-dark-200">{selectedSession.sessionId}</code></span>
                    <span>Turns: <code className="text-dark-200">{selectedSession.turnCount}</code></span>
                    <span>Storage: <code className="text-dark-200">{selectedSession.storage}</code></span>
                    {selectedSession.datasetId && (
                      <a href={`https://calibration.filscan.io/dataset/${selectedSession.datasetId}`}
                        target="_blank" rel="noopener noreferrer"
                        className="text-filecoin-400 hover:text-filecoin-300 underline">
                        View on FilScan ↗
                      </a>
                    )}
                  </div>
                </div>

                {selectedSession.turns.map(turn => (
                  <div key={turn.turnIndex} className="space-y-2">
                    <div className="flex justify-end">
                      <div className="max-w-[75%] rounded-2xl rounded-br-sm bg-filecoin-600/90 px-4 py-2.5 text-sm text-white">
                        <p className="whitespace-pre-wrap leading-relaxed">{turn.userMessage}</p>
                      </div>
                    </div>
                    <div className="flex justify-start">
                      <div className="max-w-[75%] rounded-2xl rounded-bl-sm bg-dark-800 px-4 py-2.5 text-sm text-dark-100">
                        <p className="whitespace-pre-wrap leading-relaxed">{turn.agentResponse}</p>
                      </div>
                    </div>
                    <div className="text-right text-[10px] text-dark-600">
                      Turn #{turn.turnIndex}
                      {turn.timestamp > 0 && ` · ${formatTime(turn.timestamp)}`}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
