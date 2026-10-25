@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Ярлык в папке «Автозагрузка»: помощник запускается свёрнутым при входе в Windows.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\wishlist-helper.lnk'); $s.TargetPath='%~dp0windows-start.bat'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"
if errorlevel 1 (
  echo Не получилось добавить в автозагрузку.
) else (
  echo Готово: помощник будет запускаться сам при входе в Windows.
)
pause
