#!/usr/bin/env bash
# W14 item 16 — integrate a Linnet AppImage into the desktop environment.
#
# AppImages are portable files; DEs only show them in the app list/taskbar
# once a .desktop entry + icon exist. Hand-made entries previously produced a
# broken Icon= path; this script does it properly:
#   * extracts the embedded linnet.png icon (7z when available)
#   * installs it to ~/.local/share/icons/hicolor/512x512/apps/linnet.png
#   * writes ~/.local/share/applications/linnet.desktop (Icon=linnet,
#     StartupWMClass=linnet so the running window docks onto the entry)
#
# Usage:
#   install-linux-appimage.sh [path/to/Linnet-<ver>-linux-x86_64.AppImage]
set -euo pipefail

APPIMAGE="${1:-$HOME/.local/bin/Linnet.AppImage}"
[ -f "$APPIMAGE" ] || { echo "usage: $(basename "$0") /path/to/Linnet-<ver>-linux-x86_64.AppImage" >&2; exit 1; }
chmod +x "$APPIMAGE"

APPDIR="$(cd "$(dirname "$APPIMAGE")" && pwd)"
APPFILE="$APPDIR/$(basename "$APPIMAGE")"

ICON_HOME="$HOME/.local/share/icons/hicolor/512x512/apps"
DESK="$HOME/.local/share/applications/linnet.desktop"
mkdir -p "$ICON_HOME" "$(dirname "$DESK")"

ICON=linnet
ICON_OK=0
SEVENZ="$(command -v 7z || command -v 7zz || true)"
if [ -n "$SEVENZ" ]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  # NOTE: inside the AppImage, linnet.png is a SYMLINK to the real PNG under
  # usr/share/icons/hicolor/... — extract the real path (a plain "linnet.png"
  # extraction yields a dangling link when only the link member is copied).
  "$SEVENZ" x -y "-o$TMP" "$APPFILE" usr/share/icons/hicolor/512x512/apps/linnet.png >/dev/null 2>&1 || true
  REAL="$TMP/usr/share/icons/hicolor/512x512/apps/linnet.png"
  if [ -s "$REAL" ]; then
    cp "$REAL" "$ICON_HOME/linnet.png"
    ICON_OK=1
  elif [ -s "$TMP/linnet.png" ]; then
    cp "$TMP/linnet.png" "$ICON_HOME/linnet.png"
    ICON_OK=1
  fi
fi

# Without 7z we cannot extract the PNG; point the entry at the AppImage
# itself, which many DEs (KDE, GNOME with extensions) can render as icon.
if [ "$ICON_OK" != 1 ]; then
  ICON="$APPFILE"
  echo "note: 7z not found; using the AppImage file as the icon entry" >&2
fi

cat > "$DESK" <<EOF
[Desktop Entry]
Type=Application
Name=Linnet
Comment=Matrix client between Element and Cinny
Exec="$APPFILE" %U
Icon=$ICON
Terminal=false
Categories=Network;InstantMessaging;
StartupWMClass=linnet
EOF

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" || true
echo "done — Linnet should now appear in the app grid (re-login if the shell has not refreshed its cache)"
