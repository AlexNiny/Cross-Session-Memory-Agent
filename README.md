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
        +--> Filecoin via Synapse SDK
              - encrypted app transport is not assumed
              - chat turn batches are uploaded as Filecoin pieces
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

## Filecoin Test Funds

The app uses Filecoin Calibration for demo storage. Test users need:

- tFIL for gas: [Calibration tFIL faucet](https://faucet.calibnet.chainsafe-fil.io/funds.html)
- USDFC for storage payments: [Calibration USDFC faucet](https://forest-explorer.chainsafe.dev/faucet/calibnet_usdfc)

The UI also links to both faucets from the chat and profile screens.

## User Flow

1. Connect wallet and sign the login challenge.
2. Configure provider URL, model, and API key in Settings.
3. Authorize Filecoin storage from the app.
4. Chat normally. Turns are saved locally.
5. Automatic backup queues when pending local turns reach the configured cadence.
6. Manual backup can upload the current session or all local sessions.
7. On another browser, sign in with the same wallet. The app reads D1's Filecoin registry and restores backed-up turns from Filecoin.

## Project Structure

```text
src/
  app/
    api/
      auth/                 wallet login/session APIs
      chat/                 chat, Filecoin authorization, funding APIs
      memory/               Filecoin registry and restore/backup APIs
      user/                 provider config APIs
    memory/                 memory/backup overview page
    profile/                provider and storage funding page
    page.tsx                main chat UI
  lib/
    agent.ts                LLM request orchestration
    auth.ts                 wallet auth/session helpers
    cloudflare-env.ts       Worker/D1/background task helpers
    crypto.ts               app-level encryption helpers
    memory-manager.ts       local transcript, Filecoin backup, restore logic
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
