import 'server-only';

export const config = {
  get filecoinRpcUrl() {
    return process.env.FILECOIN_RPC_URL || 'https://api.calibration.node.glif.io/rpc/v1';
  },
  get filecoinRpcUrls() {
    const configured = process.env.FILECOIN_RPC_URLS || process.env.FILECOIN_RPC_URL;
    if (configured) {
      return configured
        .split(',')
        .map((url) => url.trim())
        .filter(Boolean);
    }
    return [
      'https://api.calibration.node.glif.io/rpc/v1',
      'https://rpc.ankr.com/filecoin_testnet',
    ];
  },
  get synapseSource() {
    return process.env.SYNAPSE_SOURCE || 'cross-session-memory-agent';
  },
  get memoryLimit() {
    return parseInt(process.env.MEMORY_LIMIT || '10', 10);
  },
  get defaultProviderUrl() {
    return 'https://api.openai.com/v1';
  },
  get defaultModel() {
    return 'gpt-4o-mini';
  },
} as const;

export type AppConfig = typeof config;
