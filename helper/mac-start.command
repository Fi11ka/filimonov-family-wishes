#!/bin/bash
# Двойной щелчок в Finder запускает помощника в окне Терминала.
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then
  echo "Не найден Node.js. Установите его с https://nodejs.org (кнопка LTS) и запустите этот файл снова."
  read -r
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Первый запуск: устанавливаю компоненты..."
  npm install --omit=dev --no-audit --no-fund
fi
node helper.mjs "$@"
