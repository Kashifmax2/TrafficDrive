#!/usr/bin/env bash
# scripts/codespaces.sh
#
# One-command runner for GitHub Codespaces (or any headless Linux box).
#
#   bash scripts/codespaces.sh
#
# It does four things:
#   1. installs the runtime libraries (Xvfb, x11vnc, noVNC, Chromium deps)
#   2. starts a virtual display (:99) plus a window manager
#   3. starts the noVNC web viewer on port 6080 (forward it to your browser)
#   4. downloads + extracts the KG TRF Tool AppImage and launches the app
#
# Stop with Ctrl+C; the display keeps running so a restart is instant.

set -euo pipefail

VERSION="${TD_VERSION:-5.9.5}"
DISPLAY_NUM="${TD_DISPLAY:-:99}"
VNC_PORT=5900
WEB_PORT=6080
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPIMAGE="$REPO_DIR/KG-TRF-Tool-${VERSION}-x86_64.AppImage"
APP_BIN="$REPO_DIR/squashfs-root/KG-TRF-Tool"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

need_pkgs() {
  for c in Xvfb x11vnc websockify openbox xdotool wmctrl; do
    command -v "$c" >/dev/null 2>&1 || return 0
  done
  return 1
}

if need_pkgs; then
  say "Installing system packages (first run only, takes 1-2 minutes)"
  sudo apt-get update -qq
  # Ubuntu 24.04+ renamed libasound2 to libasound2t64
  if apt-cache show libasound2t64 >/dev/null 2>&1; then ASOUND=libasound2t64; else ASOUND=libasound2; fi
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    xvfb x11vnc novnc websockify openbox xdotool wmctrl \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 "$ASOUND" libgtk-3-0 libnotify4 libxtst6 libxss1
fi

export DISPLAY="$DISPLAY_NUM"

if ! pgrep -f "Xvfb ${DISPLAY_NUM}" >/dev/null 2>&1; then
  say "Starting virtual display ${DISPLAY_NUM} (1920x1080)"
  Xvfb "$DISPLAY_NUM" -screen 0 1920x1080x24 >/tmp/xvfb.log 2>&1 &
  sleep 1
fi

if ! pgrep -x openbox >/dev/null 2>&1; then
  openbox >/tmp/openbox.log 2>&1 &
  sleep 1
fi

if ! pgrep -x x11vnc >/dev/null 2>&1; then
  say "Starting x11vnc on port ${VNC_PORT}"
  x11vnc -display "$DISPLAY_NUM" -nopw -forever -shared -rfbport "$VNC_PORT" \
    >/tmp/x11vnc.log 2>&1 &
  sleep 1
fi

if ! pgrep -f websockify >/dev/null 2>&1; then
  WEB_DIR=/usr/share/novnc
  [ -d "$WEB_DIR" ] || WEB_DIR=/usr/share/novnc/
  say "Starting noVNC on port ${WEB_PORT}"
  websockify --web "$WEB_DIR" "$WEB_PORT" localhost:"$VNC_PORT" \
    >/tmp/websockify.log 2>&1 &
  sleep 1
fi

if [ ! -x "$APP_BIN" ]; then
  if [ ! -f "$APPIMAGE" ]; then
    say "Downloading KG TRF Tool ${VERSION} AppImage (~300 MB)"
    curl -L --fail --retry 3 -o "$APPIMAGE" \
      "https://github.com/Kashifmax2/TrafficDrive/releases/download/v${VERSION}/KG-TRF-Tool-${VERSION}-x86_64.AppImage"
  fi
  chmod +x "$APPIMAGE"
  say "Extracting AppImage (more reliable than FUSE inside a container)"
  (cd "$REPO_DIR" && "$APPIMAGE" --appimage-extract >/dev/null)
fi

# electron-builder's AppImage ships an AppRun launcher; use it when present so
# the executable name can change without breaking this script.
if [ -x "$REPO_DIR/squashfs-root/AppRun" ]; then
  APP_BIN="$REPO_DIR/squashfs-root/AppRun"
fi

say "KG TRF Tool is starting"
cat <<EOF

  Full dashboard (recommended, works in any browser):
      open forwarded port 3000  ->  https://<your-codespace>-3000.app.github.dev

  Virtual desktop (noVNC) — campaigns open their browser windows here:
      open forwarded port ${WEB_PORT} and add /vnc.html
      https://<your-codespace>-${WEB_PORT}.app.github.dev/vnc.html

  Press Ctrl+C to stop the app (the desktop and viewer keep running).

EOF

# The Electron window can start larger than the virtual screen or partly
# off-screen, where the mouse cannot reach it. Openbox gives it a titlebar
# (drag / Alt+drag / double-click to maximize) and this helper centres it.
fit_window() {
  for _ in $(seq 1 40); do
    wid=$(xdotool search --name 'KG TRF Tool' 2>/dev/null | head -1 || true)
    [ -n "${wid:-}" ] || wid=$(xdotool search --name 'TrafficDrive' 2>/dev/null | head -1 || true)
    if [ -n "${wid:-}" ]; then
      xdotool windowsize "$wid" 1500 840 2>/dev/null || true
      xdotool windowmove "$wid" 30 30 2>/dev/null || true
      return 0
    fi
    sleep 1
  done
}
fit_window &

exec "$APP_BIN" --no-sandbox
