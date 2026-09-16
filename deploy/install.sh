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

# systemd
cp "$APP_DIR/deploy/signage.service" /etc/systemd/system/signage.service
systemctl daemon-reload
systemctl enable --now signage
sleep 1

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
echo "  Data:       $APP_DIR/data  (back this folder up)"
