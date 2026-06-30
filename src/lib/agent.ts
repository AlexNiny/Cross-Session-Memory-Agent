import 'server-only';
import { checkAuthorization, getSessionKeyStatus } from './synapse';

interface ProviderConfig {
  providerUrl: string;
  apiKey: string;
  model: string;
}

function buildSystemPrompt(
  message: string,
  history: Array<{ turnIndex: number; userMessage: string; agentResponse: string }>,
  walletAddress?: string
): string {
  const filecoinNote = walletAddress
    ? checkAuthorization(walletAddress as `0x${string}`)
    : false
    ? ' (stored on Filecoin)'
    : '';
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

export async function handleUserMessage(
  sessionId: string,
  message: string,
  providerConfig: ProviderConfig,
  walletAddress?: string
): Promise<{ response: string; memoryCount: number; storageType: string }> {
  const { getMemoryManager } = await import('./memory-manager');
  const memory = await getMemoryManager();

  const history = await memory.getHistory(sessionId, walletAddress, 10);
  const systemPrompt = buildSystemPrompt(message, history, walletAddress);

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({
    baseURL: providerConfig.providerUrl.replace(/\/+$/, ''),
    apiKey: providerConfig.apiKey,
  });

  const completion = await client.chat.completions.create({
    model: providerConfig.model,
    messages: [{ role: 'user', content: systemPrompt }],
    max_tokens: 1024,
  });

  const responseText = completion.choices[0]?.message?.content?.trim() || '';

  await memory.saveTurn(sessionId, message, responseText, walletAddress);

  const info = await memory.getInfo(walletAddress);
  return {
    response: responseText,
    memoryCount: history.length + 1,
    storageType: info.type,
  };
}

export async function getStorageInfo(walletAddress?: string) {
  const { getMemoryManager } = await import('./memory-manager');
  const { config } = await import('./config');
  const memory = await getMemoryManager();
  const info = await memory.getInfo(walletAddress);

  const authStatus = walletAddress
    ? checkAuthorization(walletAddress as `0x${string}`)
    : false;

  let sessionKeyAddress;
  let sessionKeyBalance;
  let estimatedTurns;
  if (authStatus && walletAddress) {
    try {
      const { getSessionKeyStatus } = await import('./synapse');
      const info2 = getSessionKeyStatus(walletAddress as `0x${string}`);
      sessionKeyAddress = info2?.sessionKeyAddress;

      if (sessionKeyAddress) {
        const { createPublicClient, http, formatEther } = await import('viem');
        const { calibration } = await import('@filoz/synapse-sdk');
        const publicClient = createPublicClient({
          chain: calibration,
          transport: http(config.filecoinRpcUrl),
        });
        const bal = await publicClient.getBalance({
          address: sessionKeyAddress as `0x${string}`,
        });
        sessionKeyBalance = formatEther(bal);
        estimatedTurns = Number(bal / BigInt('50000000000000'));
      }
    } catch (err) {
      console.error('Failed to get session key balance:', err);
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
    estimatedTurns,
  };
}
