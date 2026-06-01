#!/usr/bin/env node
/**
 * stratos-ctl — DEPRECATED compatibility shim.
 *
 * This used to be a control panel that printed FABRICATED data (fake SOL balance, fake peer nodes,
 * fake record counts, fake "compile"/"audit" output) — a launch blocker. It has been replaced by the
 * honest `stratos` CLI (src/cli/stratos-cli.js). This shim only forwards to `stratos` so existing
 * docs/scripts keep working; it will be removed before GA.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
process.stderr.write('\x1b[33m⚠ stratos-ctl is deprecated — use `stratos`. Forwarding…\x1b[0m\n');

const child = spawn(process.execPath, [path.join(HERE, 'bin', 'stratos.js'), ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => { process.stderr.write(`stratos-ctl: failed to launch stratos: ${err.message}\n`); process.exit(1); });
