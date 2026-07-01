# Cross-Session Memory Agent - Product Overview

## One-Liner

Cross-Session Memory Agent is a wallet-authenticated AI chat app that gives users portable, Filecoin-backed conversation memory while keeping chat bodies out of the application database.

## Product Description

Most AI chat products treat memory as either temporary browser state or centralized account data. Cross-Session Memory Agent takes a different approach: the user's wallet is the identity layer, their own LLM provider handles generation, and Filecoin stores backed-up conversation memory for cross-browser and cross-device recovery.

The app is designed for Cloudflare Workers and Cloudflare D1. D1 stores user accounts, encrypted provider configuration, encrypted Filecoin session keys, and Filecoin memory indexes such as dataset IDs, PieceCIDs, synced turn indexes, and backup history. D1 does not store chat message bodies. Chat text stays in browser local storage until it is backed up to Filecoin as batched pieces.

## Why This Matters

AI memory is valuable because it makes assistants more useful over time. But memory is also sensitive. A simple server-side chat history table creates a tempting central store of private user conversations.

This project demonstrates a more privacy-conscious memory architecture:

- Users authenticate with a wallet rather than a platform-owned password account.
- Users bring their own OpenAI-compatible LLM provider.
- API keys and Filecoin session keys are encrypted before being stored in D1.
- Conversation content is not stored in D1.
- Filecoin provides durable storage for memory that should survive a tab, browser, or device.
- D1 acts as an index, not a plaintext memory warehouse.

## What's Novel

The core novelty is the split-storage model:

| Layer | Responsibility |
| --- | --- |
| Browser local storage | Immediate local transcript and pending turns |
| Cloudflare D1 | Auth, encrypted config, encrypted session keys, Filecoin indexes |
| Filecoin | Durable conversation memory pieces |
| User LLM provider | Per-user model inference |

This creates cross-session recovery without turning the app database into a chat-history database. A second browser can sign in with the same wallet, read the D1 Filecoin registry, fetch the latest PieceCIDs from Filecoin, and reconstruct the backed-up conversation.

## Target Users

- Builders experimenting with decentralized AI memory.
- Hackathon judges evaluating practical Filecoin usage.
- Users who want AI chat memory without handing the app operator a plaintext database of conversations.
- Developers who want a Cloudflare-native reference for wallet login, encrypted user settings, and Filecoin-backed data recovery.

## Key Features

- Wallet signature login with HTTP-only application sessions.
- Per-user provider URL, model, and encrypted API key.
- OpenAI-compatible chat completion support.
- Filecoin storage authorization using session keys.
- Automatic Filecoin backup cadence.
- Manual backup for the current session or all local sessions.
- Memory page showing latest CID and backup history.
- Cross-device restore using D1 registry plus Filecoin PieceCID downloads.
- D1 migration that removes the early `chat_turns` table so D1 remains index/config only.
- Test-fund links for Calibration tFIL and USDFC.

## User Journey

1. User opens the app and connects a wallet.
2. User signs a login challenge.
3. User configures their LLM provider URL, model, and API key.
4. User authorizes Filecoin storage and funds the storage account.
5. User chats normally. Turns are saved locally first.
6. The app queues Filecoin backups automatically after the configured cadence, or the user starts a manual backup.
7. The app records Filecoin dataset IDs, PieceCIDs, and synced turn indexes in D1.
8. On another browser, the same wallet signs in and the app restores backed-up turns from Filecoin.

## Architecture

```text
Wallet-authenticated browser
  - local transcript
  - provider/settings UI
  - backup and restore controls
        |
        v
Cloudflare Worker via OpenNext
  - auth APIs
  - chat API
  - memory backup/restore APIs
  - provider config APIs
        |
        +--> Cloudflare D1
        |     - users
        |     - auth nonces and sessions
        |     - encrypted provider API keys
        |     - encrypted Filecoin session keys
        |     - Filecoin memory registry and CIDs
        |
        +--> User's OpenAI-compatible provider
        |
        +--> Filecoin via Synapse SDK
              - batched chat turns
              - PieceCID-based restore
```

## Data Policy

D1 stores:

- Wallet-linked user rows.
- Login challenges and sessions.
- Provider URL and model.
- Encrypted provider API key.
- Encrypted Filecoin session private key.
- Filecoin memory registry entries.

D1 does not store:

- User chat messages.
- Assistant chat responses.
- Plaintext provider API keys.
- Plaintext Filecoin session private keys.

## Demo Narrative

The best demo is a two-browser flow:

1. Browser A signs in, chats for a few turns, and backs up to Filecoin.
2. The app displays the latest PieceCID and backup history.
3. Browser B signs in with the same wallet.
4. Browser B loads the D1 memory registry, downloads the Filecoin pieces, and restores the conversation.
5. The next LLM response uses restored memory as prompt context.

## Current Status

The project is implemented as a Cloudflare-ready Next.js application with D1 migrations, OpenNext Worker build support, wallet authentication, encrypted user configuration, Filecoin backup/restore, and a refreshed README for deployment.

## Known Constraints

- A new browser can only restore turns that have already been backed up to Filecoin.
- Production requires Cloudflare secrets for `SESSION_SECRET` and `APP_ENCRYPTION_KEY`.
- The deployed D1 database must run all migrations, including the migration that drops the old `chat_turns` table.
- Filecoin backup requires Calibration tFIL and USDFC funding during testing.
