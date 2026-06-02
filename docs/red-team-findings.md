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
### F1 — Shell-string `exec()` for ffmpeg (shell-injection class) · LOW–MED · ✅ FIXED (PR #52)
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

### F2 — Gateway had no per-request auth · LOW–MED (local defense-in-depth) · ✅ FIXED
**Severity corrected:** the gateway already binds to `127.0.0.1` (`app.listen(PORT, '127.0.0.1')`) —
it is **not** exposed on the Tailnet. So the real risk is another local process/user on the host
driving spend or the `/mcp` browser, not a Tailnet-wide exposure.
- **Fix (this PR):** opt-in shared-secret auth (`gateway-auth.js`). When `ATMOS_GATEWAY_SECRET` is
  set, `/v1/chat/completions`, `/v1/messages`, and `/mcp` require a matching `x-atmos-gateway`
  header (timing-safe). All first-party callers (Telegram bridge ×3, the 4 omni-gateway adapters,
  the pipeline model-runner) attach it automatically. Unset = prior behavior + a one-time warning,
  so enabling it is non-breaking. CORS is now scoped via `ATMOS_GATEWAY_ORIGINS`.
- **Operator action:** set `ATMOS_GATEWAY_SECRET` in the daemon env (and the same value is read by
  the in-process callers) to turn enforcement on.

### F3 — `atmos-desktop` `spawn('cmd.exe', ['/c', cmd])` · UNREVIEWED (Windows)
`sensory-ingestion.js:95`, `sensory/conversational-audio.js:72` pass a built `cmd` string to
`cmd.exe /c`. If any part of `cmd` is influenced by input, it's injectable. Needs a focused read
(pass 2) of how `cmd` is constructed.

## Pass-2 backlog (not yet audited)
- `/mcp` endpoint post-patch (confirm it rejects untrusted actions, not just the old path)
- Broker → live gateway path; the 402 write-approval loop integrity
- Telegram markdown→HTML entity escaping (injection into `parse_mode:HTML`)

## Pass 2 results (2026-06-03) — most prior gaps already remediated ✅
- **`/mcp` RCE — confirmed remediated.** `action` now runs through a safe instruction DSL
  (navigate/click/type/wait, no code compiled/evaluated). ✅ *But* `/mcp` is still
  **unauthenticated** and drives a browser harness → folds into **F2** (auth + SSRF-guard it).
- **Context-bleed (`vector-bank.js`) — remediated.** `queryAmbientMemory` filters
  `where tags = '<tag>'` (quote-escaped) for hard channel isolation. **Residual (LOW):** the tag
  param defaults to `null` → an omitting call-site silently disables isolation. *Action: audit
  call-sites; consider making the tag required.*
- **WASI sandbox (`wasi-sandbox.js`) — solid.** env is deny-by-default allowlist (no secret
  passthrough), preopens deny-by-default (mapping bug fixed), network deny-by-default, guest memory
  zeroed post-run. **Residual:** verify `job-policy.js` sanitizes `allowedPaths` against `..`/abs
  escapes before they reach the sandbox.
- **Vault (`vault-host.js`) — solid.** Decrypted seed wiped in `finally`; passcode forced to mutable
  Buffer (no V8 string-table leak); `encryptedData.fill(0)` covers IV/tag/ciphertext views; enclave
  CapSet=∅; real ML-DSA-65. **Note (correctness, not security):** no-WASM fallback generates a
  *random* identity instead of deriving from the seed → identity not reproducible in fallback mode.

### Standing priority = F2 (gateway/`/mcp` per-request auth)
The one real hardening item left from this audit: the spend-capable gateway + `/mcp` rely on the
Tailscale perimeter, no per-request auth. Recommend: confirm bind address (localhost/Tailscale iface
only), add a shared-secret header on spend + `/mcp` routes, scope CORS. Needs care not to break the
local Telegram bridge / desktop clients that call it.

## Still not audited (pass 3)
- F3 `atmos-desktop` `cmd.exe /c` string construction (Windows)
- Broker → live gateway 402 write-approval loop integrity
- Telegram markdown→HTML entity escaping (`parse_mode:HTML`)
- `job-policy.js` path sanitizer (the upstream guard for WASI preopens)

## Method note
Codex review works here only via **inline-context** (`codex exec` hangs trying to walk the FS).
Per finding: paste the file(s) into the prompt, "do not run tools," get a verdict. Keep diffs small.
