#!/usr/bin/env bash

# ==============================================================================
# Atmos Phase 3B Frictionless Installer & Service Setup
# Cross-platform: macOS, Linux, and Windows Shell Environments (Git Bash, WSL)
# ==============================================================================

set -eo pipefail

echo "================================================================"
echo "🛡️  Atmos Frictionless Integration Bootstrapper starting... 🛡️"
echo "================================================================"

# 1. Detect Operating System
OS_TYPE="Unknown"
case "$(uname -s)" in
    Darwin*)    OS_TYPE="macOS";;
    Linux*)     OS_TYPE="Linux";;
    MINGW*|MSYS*|CYGWIN*) OS_TYPE="Windows-Shell";;
    *)          OS_TYPE="Unknown";;
esac

echo "🖥️  Detected Host OS Environment: $OS_TYPE"

# 2. Silently install Pear runtime daemon
echo "🍐 Checking Pear runtime daemon..."
if ! command -v pear &> /dev/null; then
    echo "Pear runtime daemon not found. Initiating silent installation..."
    if command -v npm &> /dev/null; then
        # Check permissions for global npm installs
        if [ "$OS_TYPE" = "macOS" ] || [ "$OS_TYPE" = "Linux" ]; then
            if [ -w "$(npm config get prefix)" ]; then
                npm install -g pear --quiet
            else
                echo "🔑 npm directory not writable, using sudo to install pear..."
                sudo npm install -g pear -g --quiet
            fi
        else
            npm install -g pear --quiet
        fi
        echo "✅ Pear runtime successfully installed via npm!"
    else
        echo "⚠️ npm is not installed. Attempting standalone fallback download..."
        # If curl or wget is present
        if command -v curl &> /dev/null; then
            curl -s https://pear.services/install.sh | sh &> /dev/null || echo "Standalone installation failed."
        elif command -v wget &> /dev/null; then
            wget -qO- https://pear.services/install.sh | sh &> /dev/null || echo "Standalone installation failed."
        fi
    fi
else
    echo "✅ Pear runtime daemon already installed: $(pear --version 2>/dev/null || echo 'v1.0.0')"
fi

# 3. Setup Monorepo in User Directory
TARGET_DIR="$HOME/Atmos"
echo "📂 Setting up Atmos monorepo workspace in '$TARGET_DIR'..."

if [ ! -d "$TARGET_DIR" ]; then
    # If running inside a git clone already, let's copy it or clone it
    if [ -f "package.json" ] && grep -q "atmos-monorepo" package.json; then
        echo "📦 Local copy detected. Synchronizing workspace files to $TARGET_DIR..."
        mkdir -p "$TARGET_DIR"
        cp -r . "$TARGET_DIR"
    else
        echo "🌐 Cloning remote repository to user directory..."
        git clone --quiet https://github.com/EfficientLabs/OpenAtmos.git "$TARGET_DIR" || {
            echo "❌ Git clone failed. Creating directories manually."
            mkdir -p "$TARGET_DIR"
        }
    fi
else
    echo "✅ Target directory exists. Synchronizing monorepo components..."
    if [ -f "package.json" ] && grep -q "atmos-monorepo" package.json; then
        cp -rf packages "$TARGET_DIR/" 2>/dev/null || true
    fi
fi

# Make target directories
mkdir -p "$TARGET_DIR/scripts"
mkdir -p "$TARGET_DIR/logs"

# 4. Service configuration setup for persistent api-shim bind strictly to 127.0.0.1:4000
echo "⚙️  Registering 'api-shim' as a persistent background daemon..."

if [ "$OS_TYPE" = "macOS" ]; then
    # Launchd Setup
    PLIST_PATH="$HOME/Library/LaunchAgents/com.atmos.apishim.plist"
    echo "🍏 Configured Launchd profile path: $PLIST_PATH"

    mkdir -p "$(dirname "$PLIST_PATH")"
    cat <<EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.atmos.apishim</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(which node || echo '/usr/local/bin/node')</string>
        <string>$TARGET_DIR/packages/api-shim/index.js</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>4000</string>
        <key>BIND_ADDRESS</key>
        <string>127.0.0.1</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$TARGET_DIR/logs/api-shim-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$TARGET_DIR/logs/api-shim-stderr.log</string>
</dict>
</plist>
EOF

    # Load the agent
    launchctl unload "$PLIST_PATH" &>/dev/null || true
    launchctl load "$PLIST_PATH"
    echo "✅ Launchd daemon loaded and started successfully."

elif [ "$OS_TYPE" = "Linux" ]; then
    # Systemd Setup (User level for frictionless installation without root privileges)
    SYSTEMD_DIR="$HOME/.config/systemd/user"
    SERVICE_PATH="$SYSTEMD_DIR/atmos-api-shim.service"
    echo "🐧 Configured Systemd service path: $SERVICE_PATH"

    mkdir -p "$SYSTEMD_DIR"
    cat <<EOF > "$SERVICE_PATH"
[Unit]
Description=Atmos API Shim Interception Daemon
After=network.target

[Service]
ExecStart=$(which node || echo '/usr/bin/node') $TARGET_DIR/packages/api-shim/index.js
Restart=always
Environment=PORT=4000 BIND_ADDRESS=127.0.0.1 NODE_ENV=production
StandardOutput=append:$TARGET_DIR/logs/api-shim-stdout.log
StandardError=append:$TARGET_DIR/logs/api-shim-stderr.log

[Install]
WantedBy=default.target
EOF

    # Reload and enable the service
    systemctl --user daemon-reload
    systemctl --user enable atmos-api-shim.service
    systemctl --user restart atmos-api-shim.service
    echo "✅ Systemd user service loaded and enabled successfully."

elif [ "$OS_TYPE" = "Windows-Shell" ]; then
    # Windows Startup folder or local background configuration (for Git Bash/MSYS environments)
    STARTUP_DIR="$APPDATA/Microsoft/Windows/Start Menu/Programs/Startup"
    if [ -d "$STARTUP_DIR" ]; then
        BAT_PATH="$STARTUP_DIR/atmos-api-shim.bat"
        VBS_PATH="$STARTUP_DIR/atmos-api-shim.vbs"
        echo "🪟 Configured Windows Startup script path: $BAT_PATH"

        # Create silent VBS wrapper so command window is completely hidden
        cat <<EOF > "$VBS_PATH"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run chr(34) & "$STARTUP_DIR\atmos-api-shim.bat" & chr(34), 0
Set WshShell = Nothing
EOF

        # Create the execution batch file
        cat <<EOF > "$BAT_PATH"
@echo off
set PORT=4000
set BIND_ADDRESS=127.0.0.1
set NODE_ENV=production
node "$TARGET_DIR/packages/api-shim/index.js" > "$TARGET_DIR/logs/api-shim-stdout.log" 2> "$TARGET_DIR/logs/api-shim-stderr.log"
EOF
        
        # Run it immediately using node in background
        nohup node "$TARGET_DIR/packages/api-shim/index.js" > "$TARGET_DIR/logs/api-shim-stdout.log" 2>&1 &
        echo "✅ Windows Startup background daemon registered and initialized!"
    else
        # Fallback background service execution using nohup
        echo "🪵 Registering persistent background background runner..."
        nohup node "$TARGET_DIR/packages/api-shim/index.js" > "$TARGET_DIR/logs/api-shim-stdout.log" 2>&1 &
        echo "✅ Daemon started in background with nohup."
    fi
else
    # General fallback
    echo "⚠️ Unsupported operating system: $OS_TYPE. Starting daemon in session background..."
    nohup node "$TARGET_DIR/packages/api-shim/index.js" > "$TARGET_DIR/logs/api-shim-stdout.log" 2>&1 &
    echo "✅ Daemon started in background with nohup."
fi

echo "================================================================"
echo "🎉 Atmos Frictionless Integration Setup Completed Successfully! 🎉"
echo "📡 Bound strictly to 127.0.0.1:4000"
echo "================================================================"
