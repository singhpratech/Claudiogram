@echo off
:: Claudiogram — double-clickable launcher for Windows.
:: Starts the server if needed (requires Node.js >= 22.5) and opens the dashboard.
setlocal
set "PROJECT=%~dp0"
if not defined CLAUDIOGRAM_PORT set "CLAUDIOGRAM_PORT=4242"
set "URL=http://localhost:%CLAUDIOGRAM_PORT%"
set "LOG=%TEMP%\claudiogram.log"

:: Already running? Just open the dashboard.
curl -s -o NUL --max-time 2 "%URL%" 2>NUL
if %errorlevel%==0 (
  start "" "%URL%"
  exit /b 0
)

where node >NUL 2>NUL
if errorlevel 1 (
  echo Claudiogram needs Node.js 22.5 or newer, and none was found on this PC.
  echo Install the LTS version from https://nodejs.org and run this again.
  start "" "https://nodejs.org/"
  pause
  exit /b 1
)

node -e "const[a,b]=process.versions.node.split('.');process.exit(+a>22||(+a==22&&+b>=5)?0:1)"
if errorlevel 1 (
  echo Claudiogram needs Node.js 22.5 or newer. Please update Node, then try again.
  pause
  exit /b 1
)

cd /d "%PROJECT%"
if not exist server.js (
  echo server.js not found next to this launcher. Keep Claudiogram.bat inside the Claudiogram folder.
  pause
  exit /b 1
)

echo Starting Claudiogram...
start "Claudiogram server" /min cmd /c "set PORT=%CLAUDIOGRAM_PORT%&& node server.js >> "%LOG%" 2>&1"

:: Wait for the server to come up (first-ever scan can take a few seconds).
for /l %%i in (1,1,30) do (
  curl -s -o NUL --max-time 1 "%URL%" 2>NUL && goto :up
  timeout /t 1 /nobreak >NUL
)
echo Claudiogram did not start in time. Check the log: %LOG%
pause
exit /b 1

:up
start "" "%URL%"
exit /b 0
