#!/bin/bash
# Двойной щелчок в Finder запускает помощника в окне Терминала.
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then
  echo "Не найден Node.js. Установите его с https://nodejs.org (кнопка LTS) и запустите этот файл снова."
  read -r
  exit 1
fi
# Компоненты ставятся при первом запуске и обновляются, когда меняется их версия в package.json.
if ! node -e "require('./node_modules/playwright-core/package.json').version===require('./package.json').dependencies['playwright-core']||process.exit(1)" 2>/dev/null; then
  echo "Устанавливаю или обновляю компоненты..."
  npm install --omit=dev --no-audit --no-fund
fi
node helper.mjs "$@"
