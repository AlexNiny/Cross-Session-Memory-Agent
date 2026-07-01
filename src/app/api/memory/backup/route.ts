import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import type { ChatTurn, ClientBackupSession } from '@/lib/memory-manager';

const MAX_BACKUP_TURNS = 1000;
const MAX_BACKUP_SESSIONS = 100;
const MAX_MESSAGE_CHARS = 200_000;

function normalizeSessionId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new Error('Valid sessionId is required.');
  }
  return value;
}

function normalizeTurns(value: unknown): ChatTurn[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('turns must be an array.');
  if (value.length > MAX_BACKUP_TURNS) throw new Error(`Cannot back up more than ${MAX_BACKUP_TURNS} turns at once.`);

  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Invalid turn at index ${index}.`);
    const turn = item as Partial<ChatTurn>;
    if (!Number.isInteger(turn.turnIndex) || Number(turn.turnIndex) < 0) {
      throw new Error(`Invalid turn index at item ${index}.`);
    }
    if (typeof turn.userMessage !== 'string' || typeof turn.agentResponse !== 'string') {
      throw new Error(`Invalid message payload at item ${index}.`);
    }
    if (turn.userMessage.length > MAX_MESSAGE_CHARS || turn.agentResponse.length > MAX_MESSAGE_CHARS) {
      throw new Error(`Turn ${turn.turnIndex} is too large to back up.`);
    }
    return {
      turnIndex: Number(turn.turnIndex),
      userMessage: turn.userMessage,
      agentResponse: turn.agentResponse,
      timestamp: Number.isFinite(turn.timestamp) ? Number(turn.timestamp) : Date.now(),
    };
  });
}

function normalizeSessions(value: unknown): ClientBackupSession[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('sessions must be an array.');
  if (value.length > MAX_BACKUP_SESSIONS) throw new Error(`Cannot back up more than ${MAX_BACKUP_SESSIONS} sessions at once.`);
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid backup session.');
    const session = item as { sessionId?: unknown; turns?: unknown };
    return {
      sessionId: normalizeSessionId(session.sessionId),
      turns: normalizeTurns(session.turns),
    };
  }).filter((session) => session.turns.length > 0);
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = await req.json();
    const { sessionId, all } = body;
    const { getMemoryManager } = await import('@/lib/memory-manager');
    const memory = await getMemoryManager();

    if (all) {
      const sessions = normalizeSessions(body.sessions);
      const results = await memory.backupAllSessions(user.walletAddress, user.id, sessions);
      return NextResponse.json({ success: true, results });
    }

    const normalizedSessionId = normalizeSessionId(sessionId);
    const turns = normalizeTurns(body.turns);

    const result = await memory.queueBackupSession(normalizedSessionId, user.walletAddress, user.id, turns);
    return NextResponse.json({ success: true, result });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Backup failed';
    console.error('Memory backup API error:', err);
    const isBadRequest = /required|Invalid|Cannot|must be|too large/i.test(error);
    return NextResponse.json({ error }, { status: error === 'Authentication required.' ? 401 : isBadRequest ? 400 : 500 });
  }
}
