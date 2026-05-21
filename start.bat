@echo off
title Reader X
cd /d "%~dp0"
echo.
echo   ===  Reader X  ===
echo.
echo   Opening http://localhost:8765/ in your browser.
echo   Keep this window open while you read - close it to stop.
echo.
start "" "http://localhost:8765/"

where py >nul 2>nul
if %errorlevel%==0 (
  py -m http.server 8765
  goto done
)

where python >nul 2>nul
if %errorlevel%==0 (
  python -m http.server 8765
  goto done
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"

:done
echo.
echo   Server stopped.
pause
