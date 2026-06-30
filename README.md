# Cross-Session Memory Agent

An AI chat agent that stores conversation memory on **Filecoin** for contextual recall across sessions.

Built for **FilecoinTLDR Builder Challenge - Cycle 2**: "Build an AI Agent That Uses Filecoin"

## How It Works

1. **Configure** your LLM provider (OpenAI or any OpenAI-compatible API) in the Settings panel
2. **Chat** with the AI agent through a clean web interface
3. Each conversation turn is **stored to Filecoin** (or local storage in demo mode)
4. When you return, the agent **retrieves your history** from Filecoin and resumes as if it never forgot

## Architecture

```
Browser Settings (Provider URL + API Key)  →  POST /api/chat
                                                    ↓
                                              Agent Orchestrator  →  OpenAI-compatible API
                                                      ↕
                                                 Memory Manager
                                                      ↕
                                              ┌──────────────────┐
                                              │  Filecoin   or   │
                                              │  Local (Fallback)│
                                              └──────────────────┘
```

### Tech Stack

| Component | Technology |
|-----------|------------|
| LLM | OpenAI-compatible API (OpenAI, Groq, Together, etc.) |
| Storage | Filecoin via Synapse SDK (or local JSON fallback) |
| Auth | Session Keys (silent, no wallet popups) |
| Frontend | Next.js 14 + Tailwind CSS |

### Key Features

- **Provider-agnostic**: Use any OpenAI-compatible API (OpenAI, Groq, Together AI, local LLMs, etc.)
- **In-app configuration**: Provider URL and API key configured via UI settings — no server setup needed
- **Silent Auth**: Uses session keys for automated Filecoin signing
- **Chunked Memory**: Chat history stored as pieces in Filecoin datasets
- **Context Injection**: Retrieved memory fed directly into LLM prompt context
- **Dual Mode**: Works with Filecoin or local storage fallback

## Quick Start

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000), click the gear icon ⚙️, enter your provider URL and API key, and start chatting.

## Filecoin Storage

To enable Filecoin-backed memory storage:

1. Create a Filecoin wallet (e.g., on calibration testnet)
2. Get test FIL from the [faucet](https://faucet.calibration.fildev.network/)
3. Copy `.env.example` to `.env.local` and set `PRIVATE_KEY`

Without these, the app runs in demo mode with local-only storage.

## Project Structure

```
src/
├── app/
│   ├── api/chat/route.ts    # Chat API endpoint
│   ├── globals.css           # Tailwind styles
│   ├── layout.tsx            # Root layout
│   └── page.tsx              # Chat UI + Settings dialog
└── lib/
    ├── agent.ts              # Agent orchestrator + OpenAI-compatible client
    ├── config.ts             # Environment configuration
    ├── memory-manager.ts     # Filecoin/local memory storage
    └── synapse.ts            # Synapse SDK client setup
```
