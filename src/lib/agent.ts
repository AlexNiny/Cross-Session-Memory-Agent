import 'server-only';
import { checkAuthorization } from './synapse';
import type { ChatTurn } from './memory-manager';

interface ProviderConfig {
  providerUrl: string;
  apiKey: string;
  model: string;
}

function summarizeProviderResponse(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'string' && item.length > 300) return `${item.slice(0, 300)}...`;
      return item;
    });
  } catch {
    return String(value);
  }
}

async function buildSystemPrompt(
  message: string,
  history: Array<{ turnIndex: number; userMessage: string; agentResponse: string }>,
  walletAddress?: string
): Promise<string> {
  const hasFilecoinMemory = walletAddress
    ? await checkAuthorization(walletAddress as `0x${string}`)
    : false;
  const filecoinNote = hasFilecoinMemory ? ' (stored on Filecoin)' : '';
  const intro = `You are a helpful AI assistant with persistent memory${filecoinNote}.`;

  if (history.length === 0) {
    return `${intro}\n\nThe user says: "${message}"\n\nThis is your first conversation. Respond naturally.`;
  }

  let context = `${intro}\n\nCurrent message: "${message}"\n\nHere is your shared history with this user (chronological):\n\n`;
  for (const h of history) {
    context += `[Turn ${h.turnIndex}]\nUser: ${h.userMessage}\nYou: ${h.agentResponse}\n\n`;
  }
  context += 'Acknowledge relevant parts of your shared history naturally, then respond.';
  return context;
}

function mergeHistory(cloudHistory: ChatTurn[], clientTurns: ChatTurn[], limit: number): ChatTurn[] {
  const byIndex = new Map<number, ChatTurn>();
  for (const turn of cloudHistory) byIndex.set(turn.turnIndex, turn);
  for (const turn of clientTurns) byIndex.set(turn.turnIndex, turn);
  return Array.from(byIndex.values())
    .sort((a, b) => a.turnIndex - b.turnIndex)
    .slice(-limit);
}

export async function handleUserMessage(
  sessionId: string,
  message: string,
  providerConfig: ProviderConfig,
  walletAddress?: string,
  backupEvery = 5,
  ownerId?: string,
  clientTurns: ChatTurn[] = [],
): Promise<{ response: string; memoryCount: number; storageType: string; backup?: unknown }> {
  const { getMemoryManager } = await import('./memory-manager');
  const memory = await getMemoryManager();

  const cloudHistory = await memory.getHistory(sessionId, walletAddress, 10, ownerId);
  const history = mergeHistory(cloudHistory, clientTurns, 10);
  const systemPrompt = await buildSystemPrompt(message, history, walletAddress);

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({
    baseURL: providerConfig.providerUrl.replace(/\/+$/, ''),
    apiKey: providerConfig.apiKey,
  });

  let completion;
  try {
    completion = await client.chat.completions.create({
      model: providerConfig.model,
      messages: [{ role: 'user', content: systemPrompt }],
      max_tokens: 1024,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`LLM provider request failed for ${providerConfig.model}: ${message}`);
  }

  const content = completion.choices?.[0]?.message?.content;
  const responseText = typeof content === 'string' ? content.trim() : '';
  if (!responseText) {
    throw new Error(
      `LLM provider returned an empty or non-chat response for ${providerConfig.model}: ${summarizeProviderResponse(completion)}`,
    );
  }

  const backup = await memory.saveTurn(sessionId, message, responseText, walletAddress, backupEvery, ownerId, clientTurns);

  const info = await memory.getInfo(walletAddress);
  return {
    response: responseText,
    memoryCount: history.length + 1,
    storageType: info.type,
    backup,
  };
}

export async function getStorageInfo(walletAddress?: string) {
  const { getMemoryManager } = await import('./memory-manager');
  const { config } = await import('./config');
  const memory = await getMemoryManager();
  const info = await memory.getInfo(walletAddress);

  const authStatus = walletAddress
    ? await checkAuthorization(walletAddress as `0x${string}`)
    : false;

  let sessionKeyAddress;
  let sessionKeyBalance;
  let usdfcBalance;
  let storageUsdfcWalletBalance;
  let filecoinPayAllowance;
  let fwssApproved;
  let warmStorageAvailable;
  let usdfcTokenAddress;
  let filecoinPayAddress;
  let warmStorageAddress;
  let estimatedTurns;
  if (authStatus && walletAddress) {
    try {
      const { getSessionKeyStatus, getStorageFundingStatus } = await import('./synapse');
      const info2 = await getSessionKeyStatus(walletAddress as `0x${string}`);
      sessionKeyAddress = info2?.sessionKeyAddress;

      if (sessionKeyAddress) {
        const funding = await getStorageFundingStatus(walletAddress as `0x${string}`);
        sessionKeyBalance = funding.tfilBalance;
        usdfcBalance = funding.paymentUsdfcBalance;
        storageUsdfcWalletBalance = funding.walletUsdfcBalance;
        filecoinPayAllowance = funding.filecoinPayAllowance;
        fwssApproved = funding.fwssApproved;
        warmStorageAvailable = funding.fwssApproved && parseFloat(funding.paymentUsdfcBalance) > 0;
        usdfcTokenAddress = funding.usdfcTokenAddress;
        filecoinPayAddress = funding.filecoinPayAddress;
        warmStorageAddress = funding.warmStorageAddress;
        estimatedTurns = Number(BigInt(funding.paymentUsdfcBalanceRaw) / BigInt('5000000000000000'));
      }
    } catch (err) {
      console.error('Failed to get storage funding status:', err);
    }
  }

  return {
    ...info,
    filecoinAuthorized: authStatus,
    demoMode: !authStatus,
    memoryLimit: config.memoryLimit,
    defaultProviderUrl: config.defaultProviderUrl,
    defaultModel: config.defaultModel,
    sessionKeyAddress,
    sessionKeyBalance,
    usdfcBalance,
    storageUsdfcWalletBalance,
    filecoinPayAllowance,
    fwssApproved,
    warmStorageAvailable,
    usdfcTokenAddress,
    filecoinPayAddress,
    warmStorageAddress,
    estimatedTurns,
  };
}
