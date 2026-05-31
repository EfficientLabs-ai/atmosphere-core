@echo off
REM Atmosphere Ghost Node — Windows launcher (double-click or run from USB)
cd /d "%~dp0"
"%~dp0node.exe" "%~dp0atmos-ghost.mjs" %*
pause
