@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Установите его с https://nodejs.org ^(кнопка LTS^) и запустите этот файл снова.
  pause
  exit /b 1
)
node -e "require('./node_modules/playwright-core/package.json').version===require('./package.json').dependencies['playwright-core']||process.exit(1)" 2>nul
if errorlevel 1 (
  echo Устанавливаю или обновляю компоненты...
  call npm install --omit=dev --no-audit --no-fund
)
node helper.mjs %*
pause
