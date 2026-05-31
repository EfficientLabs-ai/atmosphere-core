# Getting started with StratosAgent

StratosAgent runs on your own machine. This guide takes you from zero to a running agent.

## 1. Prerequisites
- **Node.js 18+** (`node -v`). Install from https://nodejs.org if needed.
- **A model.** Either:
  - **Local (recommended for privacy):** install [Ollama](https://ollama.com) and pull a model:
    `ollama pull qwen2.5:7b`
  - **Cloud (BYOK):** set your own key in the environment — `export OPENAI_API_KEY=…` (or
    `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`). Keys live in your environment, never in chat or our code.

## 2. Install
```sh
npm i -g @efficientlabs/stratos
```
The installer is user-space and never uses `sudo`. If your npm global prefix isn't writable, it tells
you how to set a user-owned prefix.

## 3. Set up your agent (local-only)
```sh
stratos init      # name your agent + choose local or BYOK
```
This writes a local config. It does **not** ask for a wallet or enroll you in any network.

## 4. Check readiness
```sh
stratos doctor    # read-only preflight — reports exactly what's missing
```
`doctor` never changes anything and never phones home.

## 5. Run
```sh
stratos start     # foreground, on 127.0.0.1
```
To run it as a background service later (no root):
```sh
stratos service install   # writes a user service unit + prints the command for you to enable it
```

## 6. Configure by chatting (optional)
Bind yourself as the owner, then configure the agent from a direct message:
```sh
stratos bind <your-telegram-chat-id>
```
As the owner, in a DM, you can say things like *"call yourself Atlas"* or *"use gemma2:9b"*. Privileged
changes (file/network/shell access, switching to a cloud provider) are deliberately CLI-only — chat
explains them but never grants them.

## The Atmosphere (optional)
StratosAgent works fully standalone. Joining the peer-to-peer Atmosphere mesh is a separate, opt-in
add-on — never required, never automatic.
