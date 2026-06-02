# Red-team findings — Atmosphere infra assistant (pass 1)

**Scope:** "Is the infra assistant hackable?" First-pass audit of the api-shim gateway/bridge
(the daemon on :4099) + command-execution + owner-gating surface. Reviewers: Claude (this session)
+ Codex (`codex_reviewer`, inline). **This is pass 1 — not a complete audit.** Conservative ratings.

## ✅ Verified safe / good
- **`new Function` RCE — PATCHED.** `server.js:705` is now a security comment; the unauthenticated
  `/mcp` `new Function(action)` path is removed (guarded by `test-mcp-rce.mjs`). Confirmed.
- **Owner-gating is deny-by-default** in the channel adapters (Slack/Signal/etc. tests assert
  non-owner → skipped). Good architecture.
- **Secret-guard scans transcripts** before logging/persisting/inferring (`scanForSecrets` on the
  Telegram voice transcript). Good.
- **`model-manager.js` uses `execFile('nvidia-smi', [args])`** — no shell, array args. Safe pattern.
- **Signal adapter `spawn(cliPath, [args])`** — array args, no shell. Safe.

## ⚠️ Findings to fix
### F1 — Shell-string `exec()` for ffmpeg (shell-injection class) · LOW–MED
`packages/api-shim/src/telegram-bridge.js:272` (and pattern at `:332`):
```js
exec(`ffmpeg -y -i "${oggPath}" -ac 1 -ar 16000 "${wavPath}"`, ...)
```
- `:332` operates on internal `reply_<timestamp>` paths → not exploitable.
- `:272` uses `oggPath` from `bot.downloadFile(file_id, tempDir)` — library/Telegram-named inside a
  fixed dir, and the channel is owner-gated, so real-world exploitability is LOW. But it's the wrong
  pattern: any shell metacharacter that reaches a path breaks out.
- **Fix:** replace both with `execFile('ffmpeg', ['-y','-i',oggPath,'-ac','1','-ar','16000',wavPath], cb)`.
  Eliminates the entire shell-injection class. Trivial, no behavior change.

### F2 — Gateway has no per-request auth; relies on network perimeter · MED (defense-in-depth)
`server.js`: `app.use(cors())` (all origins) and the `/v1/chat/completions` + `/v1/messages` routes
have no bearer/owner check — the gateway trusts that it's only reachable over Tailscale/localhost.
- If *anything* on the Tailnet is compromised, the spend-capable gateway is open.
- **Fix options:** bind explicitly to 127.0.0.1/Tailscale iface only (verify), add a shared-secret
  header check on spend routes, and scope CORS to known origins. Confirm the listen address.

### F3 — `atmos-desktop` `spawn('cmd.exe', ['/c', cmd])` · UNREVIEWED (Windows)
`sensory-ingestion.js:95`, `sensory/conversational-audio.js:72` pass a built `cmd` string to
`cmd.exe /c`. If any part of `cmd` is influenced by input, it's injectable. Needs a focused read
(pass 2) of how `cmd` is constructed.

## Pass-2 backlog (not yet audited)
- `/mcp` endpoint post-patch (confirm it rejects untrusted actions, not just the old path)
- WASI sandbox boundaries (`wasi-sandbox.js`) — env passthrough, preopens, network stub
- Vault memory hygiene (`vault-host.js`) — decrypted-seed wipe, IV/tag zeroing
- Cross-channel context bleed (`vector-bank.js`) — isolatedContextTag actually filtered on retrieval
- Broker → live gateway path; the 402 write-approval loop integrity
- Telegram markdown→HTML entity escaping (injection into `parse_mode:HTML`)

## Method note
Codex review works here only via **inline-context** (`codex exec` hangs trying to walk the FS).
Per finding: paste the file(s) into the prompt, "do not run tools," get a verdict. Keep diffs small.
