import { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getOptionalD1 } from '@/lib/cloudflare-env';

export const dynamic = 'force-dynamic';

function parseJsonArray(value?: string | null) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const db = await getOptionalD1();
    let registry = {};
    if (db) {
      const rows = await db.prepare(`
        SELECT
          session_id AS sessionId,
          dataset_id AS datasetId,
          provider_address AS providerAddress,
          last_piece_cid AS lastPieceCid,
          created_at AS createdAt,
          updated_at AS updatedAt,
          piece_count AS pieceCount,
          synced_turn_indexes AS syncedTurnIndexes,
          batches
        FROM filecoin_memory_registry
        WHERE user_id = ?
      `).bind(user.id).all<{
        sessionId: string;
        datasetId?: string;
        providerAddress?: string;
        lastPieceCid?: string;
        createdAt: number;
        updatedAt: number;
        pieceCount: number;
        syncedTurnIndexes: string;
        batches: string;
      }>();
      registry = Object.fromEntries((rows.results || []).map((row) => [row.sessionId, {
        datasetId: row.datasetId,
        providerAddress: row.providerAddress,
        lastPieceCid: row.lastPieceCid,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        pieceCount: row.pieceCount,
        syncedTurnIndexes: parseJsonArray(row.syncedTurnIndexes),
        batches: parseJsonArray(row.batches),
      }]));
    }

    return NextResponse.json({ registry, localSessions: {} });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Failed to load memory index';
    return NextResponse.json({ error }, { status: error === 'Authentication required.' ? 401 : 500 });
  }
}
