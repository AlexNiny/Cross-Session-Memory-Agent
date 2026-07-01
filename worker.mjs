import openNextWorker from './.open-next/worker.js';

export {
  BucketCachePurge,
  DOQueueHandler,
  DOShardedTagCache,
} from './.open-next/worker.js';

async function processBackupMessage(message, env, ctx) {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is required for queue processing.');

  const response = await openNextWorker.fetch(
    new Request('https://cross-session-memory-agent.internal/api/internal/filecoin-backup', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csma-internal-token': env.SESSION_SECRET,
      },
      body: JSON.stringify(message.body),
    }),
    env,
    ctx,
  );

  if (!response.ok) {
    throw new Error(`Internal backup route failed (${response.status}): ${await response.text()}`);
  }
}

export default {
  fetch(request, env, ctx) {
    return openNextWorker.fetch(request, env, ctx);
  },

  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      try {
        await processBackupMessage(message, env, ctx);
        message.ack?.();
      } catch (err) {
        console.error('[CSMA-Filecoin] queue message failed:', err);
        message.retry?.();
      }
    }
  },
};
