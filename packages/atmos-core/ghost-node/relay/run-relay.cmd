@echo off
REM Atmosphere KEYLESS RELAY — backup mesh coordinator (no private key on this host)
cd /d "%~dp0"
"%~dp0node.exe" "%~dp0packages\atmos-core\mesh-demo.mjs" broadcast --topic-file "mesh-topic.txt" --signed-skill "signed-skill.wasm" --relay-id "%COMPUTERNAME%" --job-interval 15 --job-max 40
pause
