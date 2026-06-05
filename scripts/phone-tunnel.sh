#!/usr/bin/env bash
# phone-tunnel.sh — expose the loopback gateway (127.0.0.1:4099) as a public HTTPS URL so
# ElevenLabs' Custom LLM can reach StratosAgent's OpenAI-compatible endpoint.
#
# The gateway binds 127.0.0.1 ONLY (sovereign default — never a public port). A phone agent in the
# cloud therefore needs an HTTPS tunnel INTO this host. Two options, in order of preference:
#
#   1. Tailscale Funnel  (RECOMMENDED, sovereign default) — no third-party SaaS account, HTTPS via
#      your own tailnet identity, on-brand. Requires Funnel enabled in the tailnet ACL/admin.
#   2. ngrok             (the ElevenLabs article's example) — quick, but a third-party account and
#      a public ngrok endpoint. Fine for a demo; not the sovereign default.
#
# This script DETECTS what's installed and prints the exact commands. It does not assume either is
# present, and it does not start anything destructive — copy/paste the command it recommends.

set -euo pipefail
PORT="${1:-4099}"

echo "── StratosAgent phone tunnel helper ─────────────────────────────"
echo "Goal: a public HTTPS URL → http://127.0.0.1:${PORT}  (the loopback gateway)"
echo

have() { command -v "$1" >/dev/null 2>&1; }

RECO=""
if have tailscale; then RECO="tailscale"; elif have ngrok; then RECO="ngrok"; fi

# ── Tailscale Funnel ────────────────────────────────────────────────
if have tailscale; then
  echo "✅ tailscale found — RECOMMENDED (sovereign default)."
  echo
  echo "   Start the funnel (foreground; Ctrl-C to stop):"
  echo "       tailscale funnel ${PORT}"
  echo
  echo "   Or run it in the background:"
  echo "       tailscale funnel --bg ${PORT}"
  echo
  echo "   Read back the public HTTPS URL (use as PUBLIC_GATEWAY_URL, WITHOUT a trailing /v1):"
  echo "       tailscale funnel status"
  echo "       # look for the https://<machine>.<tailnet>.ts.net line mapped to 127.0.0.1:${PORT}"
  echo
  echo "   Stop it later:"
  echo "       tailscale funnel --https=443 off    # or: tailscale funnel reset"
  echo
else
  echo "ℹ️  tailscale NOT found. Install it for the sovereign default:"
  echo "       curl -fsSL https://tailscale.com/install.sh | sh"
  echo "       sudo tailscale up          # then enable Funnel in the tailnet admin/ACL"
  echo
fi

# ── ngrok ───────────────────────────────────────────────────────────
if have ngrok; then
  echo "✅ ngrok found — the article's alternative (third-party account)."
  echo
  echo "   Start the tunnel (foreground):"
  echo "       ngrok http ${PORT}"
  echo
  echo "   Read back the public HTTPS URL (use as PUBLIC_GATEWAY_URL, WITHOUT a trailing /v1):"
  echo "       curl -s http://127.0.0.1:4040/api/tunnels | python3 -c \\"
  echo "         'import sys,json;print([t[\"public_url\"] for t in json.load(sys.stdin)[\"tunnels\"] if t[\"public_url\"].startswith(\"https\")][0])'"
  echo
else
  echo "ℹ️  ngrok NOT found. To use the article's alternative:"
  echo "       # install per https://ngrok.com/download, then: ngrok config add-authtoken <token>"
  echo "       ngrok http ${PORT}"
  echo
fi

echo "─────────────────────────────────────────────────────────────────"
case "$RECO" in
  tailscale) echo "👉 Recommendation: use Tailscale Funnel (sovereign, no third-party account)." ;;
  ngrok)     echo "👉 Recommendation: tailscale not installed — ngrok is available as the fallback." ;;
  *)         echo "👉 Neither tunnel is installed. Install Tailscale (preferred) or ngrok above." ;;
esac
echo "Then export PUBLIC_GATEWAY_URL=<that https URL> and run: node scripts/phone-setup.mjs"
