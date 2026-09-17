#!/usr/bin/env bash
# One-shot installer for Debian/Ubuntu. Run from the project folder:  sudo bash deploy/install.sh
set -euo pipefail
APP_DIR=/opt/signage
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo"; exit 1; fi

# Node.js 20+ (skip if already present)
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 18 ]; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
# ffmpeg prepares videos for TVs hung on their side (their hardware may not turn video).
# Best effort: without it everything else still works, and the dashboard says what is missing.
command -v ffmpeg >/dev/null 2>&1 || apt-get install -y ffmpeg || echo "WARNING: could not install ffmpeg; videos on portrait screens may play sideways"

# The unit must run whichever node we just found or installed (nodesource: /usr/bin/node;
# tarball/nvm/snap installs live elsewhere), otherwise it fails with status 203/EXEC.
NODE_BIN="$(command -v node)"

# Service user + app folder
id -u signage >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin signage
command -v rsync >/dev/null 2>&1 || apt-get install -y rsync
mkdir -p "$APP_DIR"
rsync -a --delete --exclude node_modules --exclude data --exclude .git "$SRC_DIR/" "$APP_DIR/"
# First install: bring along any photos already uploaded on the machine you copied from
if [ ! -d "$APP_DIR/data" ] && [ -d "$SRC_DIR/data" ]; then cp -r "$SRC_DIR/data" "$APP_DIR/data"; fi
mkdir -p "$APP_DIR/data/media"
cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund
chown -R signage:signage "$APP_DIR"

# Dashboard password. Generated once, kept root-only, and never written into the unit file.
ENV_FILE=/etc/signage/signage.env
if [ ! -f "$ENV_FILE" ]; then
  mkdir -p /etc/signage
  # Node is guaranteed to exist at this point, and this avoids a pipeline that pipefail could trip on.
  GEN_PW=$(node -e "process.stdout.write(require('crypto').randomBytes(12).toString('base64url'))")
  printf 'ADMIN_PASSWORD=%s\n' "$GEN_PW" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  NEW_PW="$GEN_PW"
fi

# systemd
sed "s#^ExecStart=.*#ExecStart=$NODE_BIN /opt/signage/server.js#" "$APP_DIR/deploy/signage.service" > /etc/systemd/system/signage.service
systemctl daemon-reload
systemctl enable signage >/dev/null
# restart, not start: on an update the old code would otherwise keep running
systemctl restart signage
sleep 2
if ! systemctl is-active --quiet signage; then
  echo "signage failed to start:"; journalctl -u signage -n 30 --no-pager; exit 1
fi
curl -fsS http://127.0.0.1:8080/api/session >/dev/null || {
  echo "signage is running but not answering on port 8080:"; journalctl -u signage -n 30 --no-pager; exit 1
}

# Firewall (ufw only, if installed and active)
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 8080/tcp >/dev/null && echo "Opened port 8080 in ufw"
fi

IP=$(hostname -I | awk '{print $1}')
echo
echo "Signage is running."
echo "  Dashboard:  http://$IP:8080/"
echo "  TV player:  http://$IP:8080/player"
echo "  Logs:       journalctl -u signage -f"
if [ -n "${NEW_PW:-}" ]; then echo "  Password:   $NEW_PW   (dashboard login; saved in $ENV_FILE)"; else echo "  Password:   see ADMIN_PASSWORD in $ENV_FILE"; fi
echo "  Data:       $APP_DIR/data  (back this folder up)"
