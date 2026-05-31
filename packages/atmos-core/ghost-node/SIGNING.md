# Code-signing the Atmosphere Ghost Node (#4)

Goal: stop Windows SmartScreen / macOS Gatekeeper from warning on first run, so adoption on
locked-down machines is frictionless. **You provide the certificates; the tooling is wired.**

## What actually needs signing
The bundled `node.exe` / `node` runtimes are **already signed** by the OpenJS Foundation —
those are not the problem. What trips OS trust prompts is *our* content:

| Platform | Sign this | With | Where it must run |
| :-- | :-- | :-- | :-- |
| Windows | `install-windows.ps1` (Authenticode signature block) and any packaged `.exe` installer | a **Windows Authenticode** code-signing cert (OV ~$200–400/yr, or EV for instant SmartScreen trust) | Windows, or Linux via `osslsigncode` |
| macOS | a packaged `.app`/`.pkg` wrapper of the bundle | an **Apple Developer ID** cert ($99/yr) + notarization | macOS only (`codesign` + `notarytool`) |
| Linux | (no OS signing model) — optionally `gpg --detach-sign` the zip for integrity | a GPG key | anywhere |

## Wired hooks (env-gated — no-op until you set them)
`build.sh` calls `sign-bundles.sh` after building. It signs only what it has certs for:

```bash
# Windows Authenticode (cross-signs from Linux via osslsigncode, or use signtool on Windows):
export WIN_PFX=/path/to/codesign.pfx WIN_PFX_PASS='…'
# Apple (must run on a Mac):
export APPLE_DEVELOPER_ID="Developer ID Application: Your Name (TEAMID)"
export APPLE_NOTARY_PROFILE="atmos-notary"   # a stored notarytool keychain profile
# Linux integrity:
export GPG_SIGNING_KEY="you@efficient-labs"

bash build.sh        # build + auto-sign whatever certs are present
```

### Windows (Linux-side, osslsigncode)
```bash
osslsigncode sign -pkcs12 "$WIN_PFX" -pass "$WIN_PFX_PASS" \
  -n "Atmosphere Ghost Node" -i https://efficientlabs.ai -t http://timestamp.digicert.com \
  -in install-windows.ps1 -out install-windows.ps1   # (PS1 uses a comment-based sig block; or sign a .exe installer)
```
On Windows directly, prefer: `Set-AuthenticodeSignature .\install-windows.ps1 -Certificate $cert -TimestampServer http://timestamp.digicert.com`.

### macOS (on a Mac)
```bash
codesign --deep --force --options runtime --sign "$APPLE_DEVELOPER_ID" AtmosphereGhost.app
xcrun notarytool submit AtmosphereGhost.zip --keychain-profile "$APPLE_NOTARY_PROFILE" --wait
xcrun stapler staple AtmosphereGhost.app
```

### Linux (integrity)
```bash
gpg --local-user "$GPG_SIGNING_KEY" --armor --detach-sign atmosphere-ghost-linux-x64.zip
```

## Status
Tooling + docs are in place. **No signing happens until the env vars above point at real
certs.** Until then, unsigned bundles run fine on your own machines (click past the one-time
warning); signing is what makes it frictionless for *other people's* locked-down machines.
