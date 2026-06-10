#!/bin/sh
# Claudiogram — install as a desktop app for the current user (Linux / XDG).
# Copies the icon and writes a .desktop entry under your XDG data dir
# (~/.local/share by default). Touches nothing else.
#
# Usage:   sh scripts/make-desktop.sh
# Undo:    rm ~/.local/share/applications/claudiogram.desktop \
#             ~/.local/share/icons/hicolor/1024x1024/apps/claudiogram.png
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
LAUNCHER="$REPO/claudiogram.sh"
ICON_SRC="$SCRIPT_DIR/icon-master.png"

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
ICON_DIR="$DATA_HOME/icons/hicolor/1024x1024/apps"
ICON_DEST="$ICON_DIR/claudiogram.png"
APP_DIR="$DATA_HOME/applications"
DESKTOP_FILE="$APP_DIR/claudiogram.desktop"

if [ ! -f "$LAUNCHER" ]; then
  echo "claudiogram.sh not found at: $LAUNCHER" >&2
  echo "Keep this installer inside the Claudiogram repo's scripts/ folder." >&2
  exit 1
fi
if [ ! -f "$ICON_SRC" ]; then
  echo "icon-master.png not found at: $ICON_SRC" >&2
  exit 1
fi

# The .desktop entry execs the launcher directly, so it must be executable.
chmod +x "$LAUNCHER" 2>/dev/null || true

mkdir -p "$ICON_DIR" "$APP_DIR" || exit 1
cp -- "$ICON_SRC" "$ICON_DEST" || exit 1

# Exec= quoting per the Desktop Entry spec: the argument is wrapped in double
# quotes; backslash, double quote, backtick and dollar are escaped with a
# backslash, and the general string-escape rule (backslash -> "\\") is applied
# on top of that. "%" introduces field codes and is written literally as "%%".
EXEC_PATH=$(printf '%s' "$LAUNCHER" | sed \
  -e 's/\\/\\\\\\\\/g' \
  -e 's/"/\\\\"/g' \
  -e 's/`/\\\\`/g' \
  -e 's/\$/\\\\$/g' \
  -e 's/%/%%/g')

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Claudiogram
Comment=Claude Code usage observatory
Exec="$EXEC_PATH"
Icon=claudiogram
Terminal=false
Categories=Utility;Development;
EOF
[ -f "$DESKTOP_FILE" ] || exit 1

# Refresh desktop caches when the tools exist; failures are harmless.
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$DATA_HOME/icons/hicolor" >/dev/null 2>&1 || true
fi

echo "Installed:"
echo "  $DESKTOP_FILE"
echo "  $ICON_DEST"
echo
echo "Claudiogram should now appear in your application menu"
echo "(it launches $LAUNCHER; log out and in if your desktop caches menus)."
echo
echo "To uninstall, delete those two files:"
echo "  rm \"$DESKTOP_FILE\" \"$ICON_DEST\""
