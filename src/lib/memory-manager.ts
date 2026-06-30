import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { checkAuthorization, createWalletSynapse } from './synapse';

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

interface SessionRegistry {
  [sessionId: string]: {
    datasetId: string;
    createdAt: number;
    pieceCount: number;
    providerAddress: string;
  };
}

interface TurnRegistry {
  [sessionId: string]: { count: number };
}

// ─── Filecoin-backed Memory Store ────────────────────────────────────────

class FilecoinMemoryStore {
  async initialize(): Promise<void> {}

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

  async saveTurn(sessionId: string, turn: ChatTurn, walletAddress: `0x${string}`): Promise<void> {
    console.log('[CSMA-Filecoin] saveTurn, turn=' + turn.turnIndex + ', wallet=' + walletAddress.slice(0,10) + '...');
    const { createWalletSynapse } = await import('./synapse');
    const { synapse } = await createWalletSynapse(walletAddress as `0x${string}`);

    const data = new TextEncoder().encode(JSON.stringify({ ...turn, walletAddress }));
    const dataSize = BigInt(data.byteLength);
    console.log('[CSMA-Filecoin] data size:', Number(dataSize), 'bytes');

    // Official SDK flow: prepare → upload
    console.log('[CSMA-Filecoin] preparing account...');
    try {
      const prep = await synapse.storage.prepare({ dataSize });
      if (prep.transaction) {
        console.log('[CSMA-Filecoin] executing deposit+approval tx, amount:', prep.transaction.depositAmount.toString());
        const { hash } = await prep.transaction.execute();
        console.log('[CSMA-Filecoin] prepare tx confirmed:', hash);
      } else {
        console.log('[CSMA-Filecoin] account already funded, skipping prepare');
      }

      console.log('[CSMA-Filecoin] uploading...');
      const result = await synapse.storage.upload(data, {
        pieceMetadata: {
          sessionId,
          turnIndex: turn.turnIndex.toString(),
          timestamp: turn.timestamp.toString(),
          walletAddress,
        },
        metadata: { sessionId, walletAddress },
      });
      console.log('[CSMA-Filecoin] upload OK — PieceCID:', result.pieceCid, ', copies:', result.copies.length);
    } catch (err) {
      console.error('[CSMA-Filecoin] storage failed:', err instanceof Error ? err.message : err);
    }
  }
  async getHistory(sessionId: string, walletAddress: `0x${string}`, limit?: number): Promise<ChatTurn[]> {
    try {
      const { createWalletSynapse } = await import('./synapse');
      const { synapse } = await createWalletSynapse(walletAddress as `0x${string}`);
      const datasets = await synapse.storage.findDataSets({ address: walletAddress as `0x${string}` });
      if (datasets.length === 0) return [];

      const turns: ChatTurn[] = [];
      for (const ds of datasets) {
        const ctx = await synapse.storage.createContext({ dataSetId: ds.dataSetId });
        for await (const piece of ctx.getPieces()) {
          try {
            const raw = await ctx.download({ pieceCid: piece.pieceCid });
            const parsed = JSON.parse(new TextDecoder().decode(raw));
            turns.push({
              turnIndex: parsed.turnIndex, userMessage: parsed.userMessage,
              agentResponse: parsed.agentResponse, timestamp: parsed.timestamp,
            });
          } catch {}
        }
      }
      turns.sort((a, b) => a.turnIndex - b.turnIndex);
      return limit ? turns.slice(-limit) : turns;
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
    walletAddress?: string
  ): Promise<void> {
    const turnRegistry = this.readTurnRegistry();
    const count = turnRegistry[sessionId]?.count ?? 0;
    const addr = walletAddress as `0x${string}` | undefined;

    const turn: ChatTurn = {
      turnIndex: count,
      userMessage,
      agentResponse,
      timestamp: Date.now(),
    };

    // Always save to local (fast, reliable)
    await this.local.saveTurn(sessionId, turn, addr);

    // Also try Filecoin storage
    if (addr) {
      try {
        await this.filecoin.saveTurn(sessionId, turn, addr);
      } catch (err) {
        console.error('Filecoin save failed (non-fatal):', err);
      }
    }

    turnRegistry[sessionId] = { count: count + 1 };
    this.writeTurnRegistry(turnRegistry);
  }

  async getHistory(
    sessionId: string,
    walletAddress?: string,
    limit?: number
  ): Promise<ChatTurn[]> {
    // Prefer Filecoin history if authorized
    const addr = walletAddress as `0x${string}` | undefined;
    if (addr) {
      const filecoinHistory = await this.filecoin.getHistory(sessionId, addr, limit);
      if (filecoinHistory.length > 0) return filecoinHistory;
    }
    // Fall back to local
    return this.local.getHistory(sessionId, addr, limit);
  }

  async getInfo(walletAddress?: string): Promise<StorageInfo> {
    const addr = walletAddress as `0x${string}` | undefined;
    if (addr && checkAuthorization(addr)) {
      return this.filecoin.getInfo();
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
