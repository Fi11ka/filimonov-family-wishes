@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Установите его с https://nodejs.org ^(кнопка LTS^) и запустите этот файл снова.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Первый запуск: устанавливаю компоненты...
  call npm install --omit=dev --no-audit --no-fund
)
node helper.mjs %*
pause
