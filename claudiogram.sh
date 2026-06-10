#!/bin/sh
# Claudiogram — launcher for Linux (and any POSIX system).
# Starts the server if needed (requires Node.js >= 22.5) and opens the dashboard.
# Tip: mark this executable (chmod +x claudiogram.sh); most file managers will
# then run it on double-click, or wire it to a .desktop entry.
set -u

PROJECT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PORT="${CLAUDIOGRAM_PORT:-4242}"
URL="http://localhost:$PORT"
LOG="${XDG_STATE_HOME:-$HOME/.local/state}/claudiogram.log"

open_url() {
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then open "$URL"
  else echo "Dashboard ready at: $URL"
  fi
}

alive() {
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null --max-time 2 "$URL"
  else
    node -e "fetch('$URL',{signal:AbortSignal.timeout(2000)}).then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null
  fi
}

# Already running? Just open the dashboard.
if command -v node >/dev/null 2>&1 && alive; then
  open_url
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Claudiogram needs Node.js 22.5 or newer (https://nodejs.org), and none was found." >&2
  exit 1
fi

if ! node -e 'const[a,b]=process.versions.node.split(".");process.exit(+a>22||(+a==22&&+b>=5)?0:1)'; then
  echo "Claudiogram needs Node.js 22.5 or newer (found $(node -v))." >&2
  exit 1
fi

if [ ! -f "$PROJECT/server.js" ]; then
  echo "server.js not found next to this launcher — keep claudiogram.sh inside the Claudiogram folder." >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG")"
cd "$PROJECT" || exit 1
PORT="$PORT" nohup node server.js >> "$LOG" 2>&1 &

i=0
while [ $i -lt 60 ]; do
  if alive; then open_url; exit 0; fi
  sleep 0.5
  i=$((i + 1))
done

echo "Claudiogram did not start in time. Check the log: $LOG" >&2
exit 1
