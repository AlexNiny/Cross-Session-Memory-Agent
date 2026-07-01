import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { getFilecoinProviderIds, getFilecoinStorageCopies } from './config';
import { checkAuthorization, createWalletSynapse } from './synapse';
import type { FilecoinBackupQueueMessage } from './cloudflare-env';
import type { D1Database } from './cloudflare-env';

export interface ChatTurn {
  turnIndex: number;
  userMessage: string;
  agentResponse: string;
  timestamp: number;
}

export interface StorageInfo {
  type: 'filecoin' | 'local' | 'unavailable';
  details: Record<string, string>;
}

const REGISTRY_PATH = path.join(process.cwd(), '.memory-registry.json');
const LOCAL_PATH = path.join(process.cwd(), '.local-memory.json');
const TURN_REGISTRY_PATH = path.join(process.cwd(), '.turn-registry.json');
const BACKUP_LOCKS = new Set<string>();

interface SessionRegistry {
  [sessionId: string]: {
    datasetId: string;
    createdAt: number;
    pieceCount: number;
    providerAddress: string;
    walletAddress?: string;
    lastPieceCid?: string;
    updatedAt?: number;
    syncedTurnIndexes?: number[];
    batches?: Array<{
      pieceCid: string;
      turnIndexes: number[];
      createdAt: number;
    }>;
  };
}

type SessionRegistryEntry = SessionRegistry[string];

interface TurnRegistry {
  [sessionId: string]: { count: number };
}

export interface ClientBackupSession {
  sessionId: string;
  turns: ChatTurn[];
}

export interface BackupResult {
  uploaded: boolean;
  queued?: boolean;
  sessionId: string;
  pendingCount: number;
  syncedCount: number;
  pieceCid?: string;
  turnIndexes: number[];
  reason?: string;
}

// ─── Filecoin-backed Memory Store ────────────────────────────────────────

class FilecoinMemoryStore {
  async initialize(): Promise<void> {}

  private extractFailedProviderId(err: unknown): bigint | null {
    const message = err instanceof Error ? err.message : String(err);
    const match = message.match(/primary provider\s+(\d+)/i) || message.match(/provider\s+(\d+)/i);
    return match ? BigInt(match[1]) : null;
  }

  private appendParsedTurns(target: ChatTurn[], sessionId: string, parsed: unknown): void {
    if (!parsed || typeof parsed !== 'object') return;
    const payload = parsed as {
      sessionId?: string;
      turns?: ChatTurn[];
      turnIndex?: number;
      userMessage?: string;
      agentResponse?: string;
      timestamp?: number;
    };
    if (payload.sessionId !== sessionId) return;
    if (Array.isArray(payload.turns)) {
      for (const turn of payload.turns) {
        target.push({
          turnIndex: Number(turn.turnIndex),
          userMessage: String(turn.userMessage || ''),
          agentResponse: String(turn.agentResponse || ''),
          timestamp: Number(turn.timestamp || Date.now()),
        });
      }
      return;
    }
    if (Number.isInteger(payload.turnIndex)) {
      target.push({
        turnIndex: Number(payload.turnIndex),
        userMessage: String(payload.userMessage || ''),
        agentResponse: String(payload.agentResponse || ''),
        timestamp: Number(payload.timestamp || Date.now()),
      });
    }
  }

  private dedupeTurns(turns: ChatTurn[], limit?: number): ChatTurn[] {
    const deduped = Array.from(new Map(
      turns
        .filter((turn) => Number.isInteger(turn.turnIndex) && turn.turnIndex >= 0)
        .map((turn) => [turn.turnIndex, turn]),
    ).values()).sort((a, b) => a.turnIndex - b.turnIndex);
    return limit ? deduped.slice(-limit) : deduped;
  }

  private isTransientRpcError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /HTTP request failed|fetch failed|network|timeout/i.test(message);
  }

  private isPartialCommitError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /data is stored but not on-chain|Failed to commit on primary provider|Failed to commit pieces on-chain|StorageContext commit failed/i.test(message);
  }

  private async withRpcRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!this.isTransientRpcError(err)) throw err;
      if (label === 'upload' && this.isPartialCommitError(err)) {
        console.warn(`[CSMA-Filecoin] ${label} reached provider but commit failed; trying alternate provider path:`, err instanceof Error ? err.message : err);
        throw err;
      }
      console.warn(`[CSMA-Filecoin] ${label} RPC failed, retrying once:`, err instanceof Error ? err.message : err);
      await new Promise((resolve) => setTimeout(resolve, 750));
      return fn();
    }
  }

  private async uploadWithProviderFallback(synapse: Awaited<ReturnType<typeof createWalletSynapse>>['synapse'], data: Uint8Array) {
    const configuredProviderIds = await getFilecoinProviderIds();
    const storageCopies = await getFilecoinStorageCopies();
    console.log(
      '[CSMA-Filecoin] configured providers:',
      configuredProviderIds.length > 0 ? configuredProviderIds.map((id) => id.toString()).join(',') : 'auto',
      ', copies:',
      storageCopies,
    );
    const uploadOptions = (providerIds: bigint[]) => ({
      copies: storageCopies,
      ...(providerIds.length > 0 ? { providerIds } : {}),
      callbacks: {
        onProviderSelected: (provider: { id: bigint; pdp?: { serviceURL?: string } }) => {
          console.log('[CSMA-Filecoin] selected provider:', provider.id.toString(), provider.pdp?.serviceURL || '');
        },
      },
    });

    try {
      return await this.withRpcRetry('upload', () => synapse.storage.upload(data, uploadOptions(configuredProviderIds)));
    } catch (err) {
      if (!this.isPartialCommitError(err)) throw err;
      const failedProviderId = this.extractFailedProviderId(err);
      if (failedProviderId == null || configuredProviderIds.length === 0) throw err;

      const nextProviderIds = configuredProviderIds.filter((id) => id !== failedProviderId);
      if (nextProviderIds.length === configuredProviderIds.length || nextProviderIds.length === 0) throw err;

      console.warn('[CSMA-Filecoin] retrying upload with configured provider removed:', failedProviderId.toString());
      return await this.withRpcRetry('upload-alt-provider', () => synapse.storage.upload(data, uploadOptions(nextProviderIds)));
    }
  }

  private readRegistry(): SessionRegistry {
    try {
      return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
    } catch {
      return {};
    }
  }

  private writeRegistry(registry: SessionRegistry): void {
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
  }

  private getFilesystemSyncedTurnIndexes(sessionId: string): Set<number> {
    const entry = this.readRegistry()[sessionId];
    if (!entry) return new Set();
    if (Array.isArray(entry.syncedTurnIndexes)) return new Set(entry.syncedTurnIndexes);

    // Legacy registry entries were one piece per turn but did not record indexes.
    // Treat the first N turns as already backed up to avoid re-uploading old data.
    return new Set(Array.from({ length: entry.pieceCount || 0 }, (_, index) => index));
  }

  private async getD1(): Promise<D1Database | null> {
    try {
      const { getOptionalD1 } = await import('./cloudflare-env');
      return getOptionalD1();
    } catch {
      return null;
    }
  }

  private async readRegistryEntry(sessionId: string, ownerId?: string): Promise<SessionRegistryEntry | undefined> {
    const db = ownerId ? await this.getD1() : null;
    if (db && ownerId) {
      const row = await db.prepare(`
        SELECT
          dataset_id AS datasetId,
          provider_address AS providerAddress,
          wallet_address AS walletAddress,
          last_piece_cid AS lastPieceCid,
          piece_count AS pieceCount,
          synced_turn_indexes AS syncedTurnIndexes,
          batches,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM filecoin_memory_registry
        WHERE user_id = ? AND session_id = ?
      `).bind(ownerId, sessionId).first<{
        datasetId?: string;
        providerAddress?: string;
        walletAddress?: string;
        lastPieceCid?: string;
        pieceCount: number;
        syncedTurnIndexes: string;
        batches: string;
        createdAt: number;
        updatedAt: number;
      }>();

      if (!row) return undefined;
      return {
        datasetId: row.datasetId || '',
        providerAddress: row.providerAddress || '',
        walletAddress: row.walletAddress,
        lastPieceCid: row.lastPieceCid,
        pieceCount: Number(row.pieceCount || 0),
        syncedTurnIndexes: JSON.parse(row.syncedTurnIndexes || '[]'),
        batches: JSON.parse(row.batches || '[]'),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    }

    return this.readRegistry()[sessionId];
  }

  private async writeRegistryEntry(sessionId: string, entry: SessionRegistryEntry, ownerId?: string): Promise<void> {
    const db = ownerId ? await this.getD1() : null;
    if (db && ownerId) {
      await db.prepare(`
        INSERT INTO filecoin_memory_registry (
          user_id, session_id, dataset_id, provider_address, wallet_address, last_piece_cid,
          piece_count, synced_turn_indexes, batches, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, session_id) DO UPDATE SET
          dataset_id = excluded.dataset_id,
          provider_address = excluded.provider_address,
          wallet_address = excluded.wallet_address,
          last_piece_cid = excluded.last_piece_cid,
          piece_count = excluded.piece_count,
          synced_turn_indexes = excluded.synced_turn_indexes,
          batches = excluded.batches,
          updated_at = excluded.updated_at
      `).bind(
        ownerId,
        sessionId,
        entry.datasetId,
        entry.providerAddress,
        entry.walletAddress || '',
        entry.lastPieceCid || '',
        entry.pieceCount,
        JSON.stringify(entry.syncedTurnIndexes || []),
        JSON.stringify(entry.batches || []),
        entry.createdAt,
        entry.updatedAt || Date.now(),
      ).run();
      return;
    }

    const registry = this.readRegistry();
    registry[sessionId] = entry;
    this.writeRegistry(registry);
  }

  private async getSyncedTurnIndexes(sessionId: string, ownerId?: string): Promise<Set<number>> {
    const entry = await this.readRegistryEntry(sessionId, ownerId);
    if (!entry) return new Set();
    if (Array.isArray(entry.syncedTurnIndexes)) return new Set(entry.syncedTurnIndexes);
    return new Set(Array.from({ length: entry.pieceCount || 0 }, (_, index) => index));
  }

  async getPendingTurns(sessionId: string, turns: ChatTurn[], ownerId?: string): Promise<ChatTurn[]> {
    const synced = await this.getSyncedTurnIndexes(sessionId, ownerId);
    return turns
      .filter((turn) => !synced.has(turn.turnIndex))
      .sort((a, b) => a.turnIndex - b.turnIndex);
  }

  async backupTurns(sessionId: string, turns: ChatTurn[], walletAddress: `0x${string}`, ownerId?: string): Promise<BackupResult> {
    const syncedBefore = await this.getSyncedTurnIndexes(sessionId, ownerId);
    const pendingTurns = await this.getPendingTurns(sessionId, turns, ownerId);
    if (pendingTurns.length === 0) {
      return {
        uploaded: false,
        sessionId,
        pendingCount: 0,
        syncedCount: syncedBefore.size,
        turnIndexes: [],
        reason: 'No unsynced turns',
      };
    }
    if (BACKUP_LOCKS.has(sessionId)) {
      return {
        uploaded: false,
        sessionId,
        pendingCount: pendingTurns.length,
        syncedCount: syncedBefore.size,
        turnIndexes: pendingTurns.map((turn) => turn.turnIndex),
        reason: 'Backup already running for this session',
      };
    }

    const turnIndexes = pendingTurns.map((turn) => turn.turnIndex);
    BACKUP_LOCKS.add(sessionId);
    try {
      console.log('[CSMA-Filecoin] backupTurns, session=' + sessionId.slice(0, 8) + '..., pending=' + pendingTurns.length + ', wallet=' + walletAddress.slice(0,10) + '...');
      const { createWalletSynapse } = await import('./synapse');
      const { synapse } = await createWalletSynapse(walletAddress as `0x${string}`);

      const data = new TextEncoder().encode(JSON.stringify({
        version: 1,
        type: 'turn-batch',
        sessionId,
        walletAddress,
        createdAt: Date.now(),
        turnIndexes,
        turns: pendingTurns,
      }));
      const dataSize = BigInt(data.byteLength);
      console.log('[CSMA-Filecoin] data size:', Number(dataSize), 'bytes');

      // Log the storage account address and balance for debugging
      console.log('[CSMA-Filecoin] storage account:', synapse.client.account?.address || 'unknown');
      try {
        const { getBalance } = await import('viem/actions');
        const bal = await getBalance(synapse.client, { address: synapse.client.account?.address as `0x${string}` });
        console.log('[CSMA-Filecoin] account balance:', Number(bal) / 1e18, 'tFIL');
      } catch {}

      // Official SDK flow: prepare -> upload
      console.log('[CSMA-Filecoin] preparing account...');
      const prep = await this.withRpcRetry('prepare', () => synapse.storage.prepare({ dataSize }));
      if (prep.transaction) {
        console.log('[CSMA-Filecoin] executing deposit+approval tx, amount:', prep.transaction.depositAmount.toString());
        const { hash } = await prep.transaction.execute();
        console.log('[CSMA-Filecoin] prepare tx confirmed:', hash);
      } else {
        console.log('[CSMA-Filecoin] account already funded, skipping prepare');
      }

      console.log('[CSMA-Filecoin] uploading...');
      const result = await this.uploadWithProviderFallback(synapse, data);
      console.log('[CSMA-Filecoin] upload OK — PieceCID:', result.pieceCid, ', copies:', result.copies.length);
      const primaryCopy = result.copies[0];
      const existing = await this.readRegistryEntry(sessionId, ownerId);
      const syncedTurnIndexes = Array.from(new Set([
        ...Array.from(syncedBefore),
        ...turnIndexes,
      ])).sort((a, b) => a - b);
      const nextEntry: SessionRegistryEntry = {
        datasetId: primaryCopy?.dataSetId?.toString() || existing?.datasetId || '',
        createdAt: existing?.createdAt || Date.now(),
        pieceCount: (existing?.pieceCount || 0) + 1,
        providerAddress: primaryCopy?.providerId?.toString() || existing?.providerAddress || '',
        walletAddress,
        lastPieceCid: result.pieceCid.toString(),
        updatedAt: Date.now(),
        syncedTurnIndexes,
        batches: [
          ...(existing?.batches || []),
          { pieceCid: result.pieceCid.toString(), turnIndexes, createdAt: Date.now() },
        ],
      };
      await this.writeRegistryEntry(sessionId, nextEntry, ownerId);
      console.log('[CSMA-Filecoin] registry updated: session=' + sessionId.slice(0, 8) + '..., pieces=' + nextEntry.pieceCount + ', syncedTurns=' + syncedTurnIndexes.length);
      return {
        uploaded: true,
        sessionId,
        pendingCount: 0,
        syncedCount: syncedTurnIndexes.length,
        pieceCid: result.pieceCid.toString(),
        turnIndexes,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.isTransientRpcError(err)) {
        console.error('[CSMA-Filecoin] storage failed due to RPC/network error:', message);
      } else {
        console.error('[CSMA-Filecoin] storage failed:', message);
      }
      return {
        uploaded: false,
        sessionId,
        pendingCount: pendingTurns.length,
        syncedCount: syncedBefore.size,
        turnIndexes,
        reason: message,
      };
    } finally {
      BACKUP_LOCKS.delete(sessionId);
    }
  }
  async getHistory(sessionId: string, walletAddress: `0x${string}`, limit?: number, ownerId?: string): Promise<ChatTurn[]> {
    try {
      const { createWalletSynapse } = await import('./synapse');
      const { synapse } = await createWalletSynapse(walletAddress as `0x${string}`);
      const turns: ChatTurn[] = [];
      const registryEntry = await this.readRegistryEntry(sessionId, ownerId);
      if (registryEntry?.datasetId && registryEntry.batches?.length) {
        try {
          const ctx = await synapse.storage.createContext({ dataSetId: BigInt(registryEntry.datasetId) });
          for (const batch of registryEntry.batches) {
            try {
              const raw = await ctx.download({ pieceCid: batch.pieceCid });
              this.appendParsedTurns(turns, sessionId, JSON.parse(new TextDecoder().decode(raw)));
            } catch (err) {
              console.warn('[CSMA-Filecoin] registry restore skipped piece:', batch.pieceCid, err instanceof Error ? err.message : err);
            }
          }
          const restored = this.dedupeTurns(turns, limit);
          if (restored.length > 0) return restored;
        } catch (err) {
          console.warn('[CSMA-Filecoin] registry restore failed, falling back to dataset scan:', err instanceof Error ? err.message : err);
        }
      }

      const datasets = await synapse.storage.findDataSets({ address: walletAddress as `0x${string}` });
      if (datasets.length === 0) return [];

      for (const ds of datasets) {
        const ctx = await synapse.storage.createContext({ dataSetId: ds.dataSetId });
        for await (const piece of ctx.getPieces()) {
          try {
            const raw = await ctx.download({ pieceCid: piece.pieceCid });
            this.appendParsedTurns(turns, sessionId, JSON.parse(new TextDecoder().decode(raw)));
          } catch {}
        }
      }
      return this.dedupeTurns(turns, limit);
    } catch { return []; }
  }
  async getInfo(walletAddress?: string): Promise<StorageInfo> {
    if (!walletAddress) return { type: 'unavailable', details: {} };
    try {
      const { createWalletSynapse } = await import('./synapse');
      const { synapse } = await createWalletSynapse(walletAddress as `0x${string}`);
      const datasets = await synapse.storage.findDataSets();
      return { type: 'filecoin', details: { datasets: datasets.length.toString(), network: 'calibration' } };
    } catch {
      return { type: 'unavailable', details: {} };
    }
  }
}

// ─── Local Fallback Memory Store ───────────────────────────────────────────

class LocalMemoryStore {
  private cache: Record<string, ChatTurn[]> = {};

  async initialize(): Promise<void> {
    try {
      this.cache = JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf-8'));
    } catch {
      this.cache = {};
    }
  }

  private persist(): void {
    fs.writeFileSync(LOCAL_PATH, JSON.stringify(this.cache, null, 2), 'utf-8');
  }

  async saveTurn(sessionId: string, turn: ChatTurn, _walletAddress?: `0x${string}`): Promise<void> {
    console.log('[CSMA-Local] saveTurn: session=' + sessionId.slice(0,8) + '..., turn=' + turn.turnIndex);
    if (!this.cache[sessionId]) this.cache[sessionId] = [];
    this.cache[sessionId].push(turn);
    this.persist();
  }

  async getHistory(sessionId: string, _walletAddress?: `0x${string}`, limit?: number): Promise<ChatTurn[]> {
    const turns = this.cache[sessionId] || [];
    turns.sort((a, b) => a.turnIndex - b.turnIndex);
    return limit ? turns.slice(-limit) : turns;
  }

  getAll(): Record<string, ChatTurn[]> {
    return this.cache;
  }

  async getInfo(): Promise<StorageInfo> {
    return {
      type: 'local',
      details: {
        sessions: Object.keys(this.cache).length.toString(),
        totalTurns: Object.values(this.cache).reduce((s, t) => s + t.length, 0).toString(),
      },
    };
  }
}

// ─── Unified Memory Manager ────────────────────────────────────────────────

function normalizeChatTurns(turns: ChatTurn[]): ChatTurn[] {
  return Array.from(new Map(
    turns
      .filter((turn) => Number.isInteger(turn.turnIndex) && turn.turnIndex >= 0)
      .map((turn) => [turn.turnIndex, turn]),
  ).values()).sort((a, b) => a.turnIndex - b.turnIndex);
}

function nextTurnIndex(turns: ChatTurn[]): number {
  if (turns.length === 0) return 0;
  return Math.max(...turns.map((turn) => turn.turnIndex)) + 1;
}

function backupQueueMessage(
  source: FilecoinBackupQueueMessage['source'],
  sessionId: string,
  walletAddress: `0x${string}`,
  turns: ChatTurn[],
  ownerId?: string,
): FilecoinBackupQueueMessage {
  return {
    kind: 'filecoin-backup',
    source,
    sessionId,
    walletAddress,
    ownerId,
    turns: normalizeChatTurns(turns),
  };
}

export class MemoryManager {
  private filecoin: FilecoinMemoryStore;
  private local: LocalMemoryStore;

  constructor() {
    this.filecoin = new FilecoinMemoryStore();
    this.local = new LocalMemoryStore();
  }

  async initialize(): Promise<void> {
    await this.filecoin.initialize();
    await this.local.initialize();
  }

  async saveTurn(
    sessionId: string,
    userMessage: string,
    agentResponse: string,
    walletAddress?: string,
    backupEvery = 5,
    ownerId?: string,
    clientTurns: ChatTurn[] = [],
  ): Promise<BackupResult | null> {
    const normalizedClientTurns = normalizeChatTurns(clientTurns);
    const turnRegistry = this.readTurnRegistry();
    const count = ownerId
      ? nextTurnIndex(normalizedClientTurns)
      : turnRegistry[sessionId]?.count ?? nextTurnIndex(normalizedClientTurns);
    const addr = walletAddress as `0x${string}` | undefined;

    const turn: ChatTurn = {
      turnIndex: count,
      userMessage,
      agentResponse,
      timestamp: Date.now(),
    };

    if (!ownerId) {
      await this.local.saveTurn(sessionId, turn, addr);
      turnRegistry[sessionId] = { count: count + 1 };
      this.writeTurnRegistry(turnRegistry);
    }

    const threshold = Number.isFinite(backupEvery) ? Math.max(1, Math.floor(backupEvery)) : 5;
    if (addr && await checkAuthorization(addr)) {
      const localTurns = ownerId
        ? normalizeChatTurns([...normalizedClientTurns, turn])
        : await this.local.getHistory(sessionId, addr);
      const pendingTurns = await this.filecoin.getPendingTurns(sessionId, localTurns, ownerId);
      console.log('[CSMA-Filecoin] auto backup check: pending=' + pendingTurns.length + ', threshold=' + threshold);
      if (pendingTurns.length >= threshold) {
        const { enqueueFilecoinBackup } = await import('./cloudflare-env');
        const queued = await enqueueFilecoinBackup(backupQueueMessage('auto', sessionId, addr, localTurns, ownerId));
        return {
          uploaded: false,
          queued,
          sessionId,
          pendingCount: pendingTurns.length,
          syncedCount: localTurns.length - pendingTurns.length,
          turnIndexes: pendingTurns.map((pendingTurn) => pendingTurn.turnIndex),
          reason: queued ? 'Backup queued' : 'FILECOIN_BACKUP_QUEUE binding is not configured',
        };
      }
    }

    return null;
  }

  async backupSession(
    sessionId: string,
    walletAddress?: string,
    ownerId?: string,
    clientTurns: ChatTurn[] = [],
  ): Promise<BackupResult> {
    const addr = walletAddress as `0x${string}` | undefined;
    if (!addr) {
      return { uploaded: false, sessionId, pendingCount: 0, syncedCount: 0, turnIndexes: [], reason: 'Wallet not connected' };
    }
    if (!await checkAuthorization(addr)) {
      return { uploaded: false, sessionId, pendingCount: 0, syncedCount: 0, turnIndexes: [], reason: 'Session key not authorized' };
    }

    const localTurns = ownerId
      ? normalizeChatTurns(clientTurns)
      : clientTurns.length > 0
        ? normalizeChatTurns(clientTurns)
        : await this.local.getHistory(sessionId, addr);
    const pendingTurns = await this.filecoin.getPendingTurns(sessionId, localTurns, ownerId);
    if (pendingTurns.length === 0) {
      return {
        uploaded: false,
        sessionId,
        pendingCount: 0,
        syncedCount: localTurns.length,
        turnIndexes: [],
        reason: 'No unsynced turns',
      };
    }

    try {
      return await this.filecoin.backupTurns(sessionId, localTurns, addr, ownerId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        uploaded: false,
        sessionId,
        pendingCount: pendingTurns.length,
        syncedCount: localTurns.length - pendingTurns.length,
        turnIndexes: pendingTurns.map((turn) => turn.turnIndex),
        reason: message,
      };
    }
  }

  async queueBackupSession(
    sessionId: string,
    walletAddress?: string,
    ownerId?: string,
    clientTurns: ChatTurn[] = [],
  ): Promise<BackupResult> {
    const addr = walletAddress as `0x${string}` | undefined;
    if (!addr) {
      return { uploaded: false, sessionId, pendingCount: 0, syncedCount: 0, turnIndexes: [], reason: 'Wallet not connected' };
    }
    if (!await checkAuthorization(addr)) {
      return { uploaded: false, sessionId, pendingCount: 0, syncedCount: 0, turnIndexes: [], reason: 'Session key not authorized' };
    }

    const localTurns = ownerId
      ? normalizeChatTurns(clientTurns)
      : clientTurns.length > 0
        ? normalizeChatTurns(clientTurns)
        : await this.local.getHistory(sessionId, addr);
    const pendingTurns = await this.filecoin.getPendingTurns(sessionId, localTurns, ownerId);
    if (pendingTurns.length === 0) {
      return {
        uploaded: false,
        sessionId,
        pendingCount: 0,
        syncedCount: localTurns.length,
        turnIndexes: [],
        reason: 'No unsynced turns',
      };
    }

    const { enqueueFilecoinBackup } = await import('./cloudflare-env');
    const queued = await enqueueFilecoinBackup(backupQueueMessage('manual', sessionId, addr, localTurns, ownerId));

    return {
      uploaded: false,
      queued,
      sessionId,
      pendingCount: pendingTurns.length,
      syncedCount: localTurns.length - pendingTurns.length,
      turnIndexes: pendingTurns.map((turn) => turn.turnIndex),
      reason: queued ? 'Backup queued' : 'FILECOIN_BACKUP_QUEUE binding is not configured',
    };
  }

  async processQueuedBackup(message: FilecoinBackupQueueMessage): Promise<BackupResult> {
    if (message.kind !== 'filecoin-backup') {
      throw new Error('Unsupported backup queue message.');
    }
    const addr = message.walletAddress as `0x${string}`;
    if (!await checkAuthorization(addr)) {
      return {
        uploaded: false,
        sessionId: message.sessionId,
        pendingCount: 0,
        syncedCount: 0,
        turnIndexes: [],
        reason: 'Session key not authorized',
      };
    }
    const turns = normalizeChatTurns(message.turns);
    console.log('[CSMA-Filecoin] queue backup start: source=' + message.source + ', session=' + message.sessionId.slice(0, 8) + '..., turns=' + turns.length);
    const result = await this.filecoin.backupTurns(message.sessionId, turns, addr, message.ownerId);
    if (result.uploaded) {
      console.log('[CSMA-Filecoin] queue backup complete: session=' + message.sessionId.slice(0, 8) + '..., turns=' + result.turnIndexes.length);
    } else if (result.reason) {
      console.warn('[CSMA-Filecoin] queue backup skipped/failed: session=' + message.sessionId.slice(0, 8) + '..., reason=' + result.reason);
    }
    return result;
  }

  async getBackupStatus(sessionId: string, ownerId?: string): Promise<{ pendingCount: number; syncedCount: number; localCount: number }> {
    void ownerId;
    const localTurns = await this.local.getHistory(sessionId);
    const pendingTurns = await this.filecoin.getPendingTurns(sessionId, localTurns, ownerId);
    return {
      pendingCount: pendingTurns.length,
      syncedCount: localTurns.length - pendingTurns.length,
      localCount: localTurns.length,
    };
  }

  async backupAllSessions(
    walletAddress?: string,
    ownerId?: string,
    clientSessions: ClientBackupSession[] = [],
  ): Promise<BackupResult[]> {
    const sessions = clientSessions.length > 0
      ? clientSessions
      : Object.entries(this.local.getAll()).map(([sessionId, turns]) => ({ sessionId, turns }));
    const results: BackupResult[] = [];
    for (const session of sessions) {
      try {
        results.push(await this.queueBackupSession(session.sessionId, walletAddress, ownerId, session.turns));
      } catch (err) {
        results.push({
          uploaded: false,
          sessionId: session.sessionId,
          pendingCount: 0,
          syncedCount: 0,
          turnIndexes: [],
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  async restoreHistory(
    sessionId: string,
    walletAddress?: string,
    ownerId?: string,
  ): Promise<{ source: 'filecoin' | 'local' | 'none'; turns: ChatTurn[] }> {
    const addr = walletAddress as `0x${string}` | undefined;
    if (addr) {
      const filecoinHistory = await this.filecoin.getHistory(sessionId, addr, undefined, ownerId);
      if (filecoinHistory.length > 0) return { source: 'filecoin', turns: filecoinHistory };
    }

    const localHistory = await this.local.getHistory(sessionId);
    if (localHistory.length > 0) return { source: 'local', turns: localHistory };
    return { source: 'none', turns: [] };
  }

  async getHistory(
    sessionId: string,
    walletAddress?: string,
    limit?: number,
    ownerId?: string,
  ): Promise<ChatTurn[]> {
    const addr = walletAddress as `0x${string}` | undefined;
    if (addr) {
      const filecoinHistory = await this.filecoin.getHistory(sessionId, addr, limit, ownerId);
      if (filecoinHistory.length > 0) return filecoinHistory;
    }
    return this.local.getHistory(sessionId, addr, limit);
  }

  async getInfo(walletAddress?: string): Promise<StorageInfo> {
    const addr = walletAddress as `0x${string}` | undefined;
    if (addr && await checkAuthorization(addr)) {
      return this.filecoin.getInfo(addr);
    }
    return this.local.getInfo();
  }

  hasFilecoinAccess(walletAddress?: string): boolean {
    if (!walletAddress) return false;
    return walletAddress != null;
  }

  private readTurnRegistry(): TurnRegistry {
    try {
      return JSON.parse(fs.readFileSync(TURN_REGISTRY_PATH, 'utf-8'));
    } catch {
      return {};
    }
  }

  private writeTurnRegistry(data: TurnRegistry): void {
    fs.writeFileSync(TURN_REGISTRY_PATH, JSON.stringify(data, null, 2), 'utf-8');
  }
}

export let memoryManager: MemoryManager | null = null;

export async function getMemoryManager(): Promise<MemoryManager> {
  if (!memoryManager) {
    memoryManager = new MemoryManager();
    await memoryManager.initialize();
  }
  return memoryManager;
}
