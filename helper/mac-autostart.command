#!/bin/bash
# Запуск помощника при входе в macOS и перезапуск, если он остановился.
cd "$(dirname "$0")"
DIR="$(pwd)"
NODE="$(command -v node)"
if [ -z "$NODE" ]; then echo "Сначала установите Node.js с https://nodejs.org"; read -r; exit 1; fi
if [ ! -f helper.config.json ]; then
  echo "Сначала один раз запустите mac-start.command и введите адрес и ключ."; read -r; exit 1
fi
"$NODE" -e "require('./node_modules/playwright-core/package.json').version===require('./package.json').dependencies['playwright-core']||process.exit(1)" 2>/dev/null || npm install --omit=dev --no-audit --no-fund
PLIST="$HOME/Library/LaunchAgents/ru.filimonov.wishlist-helper.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ru.filimonov.wishlist-helper</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/helper.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/helper.log</string>
  <key>StandardErrorPath</key><string>$DIR/helper.log</string>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null
launchctl load "$PLIST" && echo "Готово: помощник работает в фоне и будет запускаться сам. Журнал: $DIR/helper.log"
read -r
