# Cross-Session Memory Agent

An AI chat application with wallet login, per-user LLM provider settings, and Filecoin-backed memory that can be restored across browsers or devices.

Built for the FilecoinTLDR Builder Challenge - Cycle 2.

## What It Does

- Lets users sign in with an EVM wallet signature.
- Stores each user's provider URL, model, and encrypted API key in Cloudflare D1.
- Sends each user's chat requests to their own configured OpenAI-compatible provider.
- Keeps chat text out of D1. Conversation content lives in the browser first, then in Filecoin backups.
- Stores only indexes and configuration in D1, including Filecoin dataset IDs, PieceCIDs, synced turn indexes, auth sessions, provider settings, and encrypted session keys.
- Restores backed-up conversations on another browser/device by reading D1's Filecoin index and downloading the corresponding pieces from Filecoin.
- Runs Filecoin backups asynchronously through Cloudflare Queues, with retry handling and post-submit commit recovery for transient PDP/RPC failures.

## Architecture

```text
Browser
  - wallet login
  - local chat transcript
  - manual/auto backup payloads
        |
        v
Cloudflare Worker / OpenNext
  - auth/session APIs
  - chat API
  - provider config APIs
  - memory index APIs
        |
        +--> Cloudflare D1
        |     - users
        |     - auth sessions/nonces
        |     - encrypted provider API keys
        |     - encrypted Filecoin session keys
        |     - Filecoin registry: dataset IDs, PieceCIDs, synced turn indexes
        |
        +--> User-configured LLM provider
        |
        +--> Cloudflare Queue: filecoin-backups
              |
              v
              Filecoin Warm Storage via Synapse SDK
              - chat turn batches are uploaded as Filecoin pieces
              - optional single PDP provider pinning
              - commit status recovery after tx submission
```

## Storage Model

D1 intentionally does not store chat message bodies.

| Data | Location |
| --- | --- |
| Wallet user record | D1 |
| Login nonce/session | D1 |
| Provider URL/model | D1 |
| Provider API key | D1, encrypted with `APP_ENCRYPTION_KEY` |
| Filecoin session private key | D1, encrypted with `APP_ENCRYPTION_KEY` |
| Chat transcript before backup | Browser `localStorage` |
| Backed-up chat transcript | Filecoin pieces |
| Backup indexes, latest CID, history CIDs | D1 `filecoin_memory_registry` |

This means a new browser can restore only turns that have already been backed up to Filecoin.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | Next.js 15, React, Tailwind CSS |
| Worker runtime | Cloudflare Workers via OpenNext |
| Database | Cloudflare D1 SQLite |
| Filecoin storage | Synapse SDK |
| LLM | Any OpenAI-compatible provider |
| Wallet/auth | EVM wallet signature + HTTP-only app session |

## How to Use

### 1. Sign in with a wallet

Open the app and click **Connect wallet**. The app asks the wallet to sign a login challenge and then creates an HTTP-only application session.

### 2. Configure your LLM provider

Open **Settings** and enter:

- Provider URL, for example `https://openrouter.ai/api/v1` or another OpenAI-compatible endpoint
- Model name
- API key

The provider URL and model are stored in D1. The API key is encrypted before it is stored.

### 3. Prepare Filecoin storage

Use the faucet buttons in the app, or open these directly:

- [Get Calibration tFIL](https://faucet.calibnet.chainsafe-fil.io/funds.html)
- [Get Calibration USDFC](https://forest-explorer.chainsafe.dev/faucet/calibnet_usdfc)

Then click **Authorize storage** in the chat UI, or use the funding controls on the **Profile** page. The app creates and authorizes a Filecoin session key so backups can run without repeated wallet popups.

### 4. Chat normally

Start a session and send messages. Completed user/assistant turns are saved in browser `localStorage` first. They are not written to D1.

Each LLM request uses the provider URL and API key configured by the signed-in user.

### 5. Back up memory to Filecoin

The app can back up turns in two ways:

- Automatic backup: runs when pending local turns reach the configured **Backup cadence**.
- Manual backup: use **Backup now** for the current session or **Backup all local sessions** for all browser-local sessions.

Backups are queued asynchronously so chat responses are not blocked by Filecoin upload work. After a successful upload, the Memory page shows the latest PieceCID and backup history.

On Cloudflare, Filecoin backup work is processed by Cloudflare Queues instead of `ctx.waitUntil()`. This avoids the 30-second post-response `waitUntil()` limit for long Filecoin prepare/upload operations. Retryable PDP/RPC commit failures return a failed queue response so the message is retried instead of being acknowledged as complete.

If the PDP provider returns a commit transaction hash but the first status poll fails, the worker performs a recovery check against the provider status endpoints. A recovered commit is treated as a successful backup and written into the D1 Filecoin registry.

### 6. Restore on another browser or device

Open the app somewhere else and sign in with the same wallet. The app reads the D1 Filecoin registry, downloads the indexed pieces from Filecoin, and reconstructs backed-up conversations locally.

Only turns already backed up to Filecoin can be restored on a new browser. Turns that exist only in one browser's `localStorage` stay local until backed up.

## Local Development

Install dependencies:

```bash
pnpm install
```

Create local Worker variables:

```bash
cp .dev.vars.example .dev.vars
```

Set strong local secrets in `.dev.vars`:

```bash
SESSION_SECRET="at-least-32-random-characters"
APP_ENCRYPTION_KEY="another-32-plus-random-character-secret"
```

Apply D1 migrations locally:

```bash
pnpm d1:migrate:local
```

Run the app locally:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Cloudflare Setup

Create a D1 database:

```bash
wrangler d1 create cross-session-memory-agent
```

Copy the returned `database_id` into `wrangler.jsonc`.

Create the Filecoin backup queue:

```bash
wrangler queues create filecoin-backups
```

Set production secrets:

```bash
wrangler secret put SESSION_SECRET
wrangler secret put APP_ENCRYPTION_KEY
```

Apply remote migrations:

```bash
pnpm d1:migrate:remote
```

Build and deploy:

```bash
pnpm cf:build
pnpm cf:deploy
```

The Worker entrypoint is `worker.mjs`, which wraps the OpenNext Worker for HTTP requests and exports a Queue consumer for Filecoin backup jobs.

### Queue Behavior

`worker.mjs` consumes the `filecoin-backups` queue and forwards each job to the internal backup API route. Failed jobs call `message.retry({ delaySeconds: 10 })`; the queue consumer is configured with `max_retries: 3` in `wrangler.jsonc`.

This is intentionally used for Filecoin uploads because backups can include account preparation, upload, chain commit, and provider status polling. These operations are too long and too failure-prone for a normal chat request or a short `waitUntil()` task.

### Filecoin Provider Tuning

To store backups with one specific Calibration PDP provider, set:

```bash
FILECOIN_PROVIDER_ID=2
FILECOIN_STORAGE_COPIES=1
```
Check active providers: [Providers](https://filecoin.cloud/service-providers?chain=314159&sort=serviceOffered.desc)

When `FILECOIN_PROVIDER_ID` is set, the backup worker creates a storage context for exactly that provider, verifies the resolved provider ID, and uploads a single copy through that context. It will not fall back to another provider.

Leave `FILECOIN_PROVIDER_ID` empty to let Synapse choose providers automatically. In automatic mode, `FILECOIN_STORAGE_COPIES` controls the requested copy count.

The default Cloudflare config currently pins Calibration provider `2` and requests one copy:

```jsonc
"FILECOIN_PROVIDER_ID": "2",
"FILECOIN_STORAGE_COPIES": "1"
```

Typical successful backup logs look like:

```text
[CSMA-Filecoin] configured provider: 2 , copies: 1
[CSMA-Filecoin] selected provider: 2 https://calib2.ezpdpz.net
[CSMA-Filecoin] stored on provider: 2 bafk...
[CSMA-Filecoin] commit tx submitted: 0x... provider: 2
[CSMA-Filecoin] commit confirmed: dataset=... provider=2
```

When the first status poll fails after a transaction was submitted, recovery logs may appear:

```text
[CSMA-Filecoin] commit confirmation failed after tx submission; attempting status recovery: 0x...
[CSMA-Filecoin] recovering add-pieces status: https://...
[CSMA-Filecoin] commit recovery confirmed: dataset=... provider=2
```

## Filecoin Test Funds

The app uses Filecoin Calibration for demo storage. Test users need:

- tFIL for gas: [Calibration tFIL faucet](https://faucet.calibnet.chainsafe-fil.io/funds.html)
- USDFC for storage payments: [Calibration USDFC faucet](https://forest-explorer.chainsafe.dev/faucet/calibnet_usdfc)

The UI also links to both faucets from the chat and profile screens.

## Project Structure

```text
src/
  app/
    api/
      auth/                 wallet login/session APIs
      chat/                 chat, Filecoin authorization, funding APIs
      internal/             Queue-only Filecoin backup worker endpoint
      memory/               Filecoin registry and restore/backup APIs
      user/                 provider config APIs
    memory/                 memory/backup overview page
    profile/                provider and storage funding page
    page.tsx                main chat UI
  lib/
    agent.ts                LLM request orchestration
    auth.ts                 wallet auth/session helpers
    cloudflare-env.ts       Worker/D1/Queue environment helpers
    crypto.ts               app-level encryption helpers
    memory-manager.ts       local transcript, Filecoin backup, commit recovery, restore logic
    provider-url.ts         provider URL validation
    synapse.ts              Synapse SDK/session-key/funding logic
    user-config.ts          per-user provider config persistence
migrations/                 D1 schema migrations
wrangler.jsonc              Cloudflare Worker/D1 config
open-next.config.ts         OpenNext Cloudflare config
```

## Verification

Useful checks before deployment:

```bash
pnpm build
pnpm cf:build
```

`pnpm lint` is present for compatibility with older Next.js workflows, but this project currently relies on the build/typecheck path as the primary gate.

## Security Notes

- Never commit `.dev.vars`, `.env.local`, or production secret values.
- Rotate `SESSION_SECRET` or `APP_ENCRYPTION_KEY` carefully. Existing sessions or encrypted rows may become unreadable.
- Keep `ALLOW_UNSAFE_PROVIDER_URLS=false` in production. It exists only for local/self-hosted LLM development.
- D1 migrations include `0005_drop_chat_turns.sql` to remove the old chat-body table from early development.
