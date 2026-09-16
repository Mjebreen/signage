#!/usr/bin/env bash
# Add a Cloudflare Tunnel to an existing LAN Signage install so TVs anywhere on the
# internet can use https://<your-hostname>/player.
#
# Run AFTER deploy/install.sh, on the server:   sudo bash deploy/install-tunnel.sh
# It asks for the tunnel token and hostname from the Cloudflare dashboard (README:
# "Reach the TVs over the internet"). Re-running is safe and is also how you install a
# new token.  Remove the tunnel again with:     sudo bash deploy/install-tunnel.sh --remove
#
# Passing the token as an argument works too but leaves it in your shell history;
# prefer the prompt.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo"; exit 1; }
ENV_FILE=/etc/signage/signage.env

if [ "${1:-}" = "--remove" ]; then
  # `service uninstall` disables and stops cloudflared.service, removes the unit files it
  # wrote and /etc/cloudflared/token. Our ordering drop-in is ours to remove.
  cloudflared service uninstall 2>/dev/null || true
  rm -rf /etc/systemd/system/cloudflared.service.d /etc/cloudflared
  systemctl daemon-reload
  [ -f "$ENV_FILE" ] && sed -i '/^PUBLIC_URL=/d' "$ENV_FILE"
  systemctl restart signage
  echo "Tunnel removed from this server. Also delete the tunnel in the dashboard (Networking > Tunnels)."
  echo "To remove the package too: apt-get remove -y cloudflared; rm -f /etc/apt/sources.list.d/cloudflared.list"
  exit 0
fi

systemctl is-enabled signage >/dev/null 2>&1 || { echo "signage.service not found - run: sudo bash deploy/install.sh first"; exit 1; }
# The app refuses to start with PUBLIC_URL set and no password, so check before we set it.
grep -qE '^ADMIN_PASSWORD=.+' "$ENV_FILE" 2>/dev/null || { echo "No ADMIN_PASSWORD in $ENV_FILE - run: sudo bash deploy/install.sh first"; exit 1; }

RAW="${1:-}"; HOST="${2:-}"
[ -n "$RAW" ]  || read -r -p "Paste the tunnel token (the long text starting with eyJ): " RAW
[ -n "$HOST" ] || read -r -p "Public hostname (e.g. signage.example.com): " HOST
# Accept the bare token or the whole "sudo cloudflared service install eyJ..." line.
TOKEN="$(printf '%s' "$RAW" | grep -oE 'eyJ[A-Za-z0-9+/=_-]+' | head -n1 || true)"
[ -n "$TOKEN" ] || { echo "That does not look like a tunnel token (it starts with eyJ)"; exit 1; }
HOST="$(printf '%s' "$HOST" | sed -E 's#^https?://##; s#/.*$##')"
[ -n "$HOST" ] || { echo "Hostname is required"; exit 1; }

# 1) cloudflared from Cloudflare's own apt repository, so plain apt keeps it updated.
#    The "any" suite is the one Cloudflare marks Recommended and works on every Debian/Ubuntu.
export DEBIAN_FRONTEND=noninteractive
apt-get update
command -v curl >/dev/null 2>&1 || apt-get install -y curl ca-certificates
mkdir -p --mode=0755 /usr/share/keyrings
# Always re-download the keyring: Cloudflare rolled its signing key on 30 Oct 2025 and
# removed the old keys on 30 Apr 2026; a stale keyring makes apt-get update fail.
tmp="$(mktemp)"
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o "$tmp"
install -m 0644 "$tmp" /usr/share/keyrings/cloudflare-main.gpg
rm -f "$tmp"
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  > /etc/apt/sources.list.d/cloudflared.list
apt-get update
apt-get install -y cloudflared
echo "cloudflared: $(cloudflared --version)"

# 2) Tell the app its public address. This makes the dashboard password mandatory and
#    prints the public URLs at startup.
sed -i '/^PUBLIC_URL=/d' "$ENV_FILE"
printf 'PUBLIC_URL=https://%s\n' "$HOST" >> "$ENV_FILE"
chmod 600 "$ENV_FILE"
systemctl restart signage

# 3) Start the tunnel after the app on boot. After= only, never Requires=: the tunnel must
#    stay up while signage restarts, so a TV sees cloudflared's clear "502 unable to reach
#    the origin" for a moment instead of a Cloudflare 1033/530.
mkdir -p /etc/systemd/system/cloudflared.service.d
printf '[Unit]\nAfter=signage.service\n' > /etc/systemd/system/cloudflared.service.d/10-signage.conf

# 4) The systemd service, driven by the token. `service install` refuses to run if the unit
#    already exists, so uninstall first; that is also Cloudflare's documented way to rotate a
#    token. It writes /etc/systemd/system/cloudflared.service (runs as root, Restart=on-failure)
#    and the token to /etc/cloudflared/token (mode 0600), then enables and starts it.
cloudflared service uninstall >/dev/null 2>&1 || true
if ! cloudflared service install "$TOKEN"; then
  echo "cloudflared could not start. Most likely a wrong or rotated token, or outbound TCP/UDP 7844 is blocked."
  echo "Details: journalctl -u cloudflared -n 50 --no-pager"
  exit 1
fi

# 5) Wait for the tunnel to connect. cloudflared's local metrics listener answers /ready with
#    200 only while it has an active connection to Cloudflare (cloudflared metrics/readiness.go;
#    also used by Cloudflare's Kubernetes guide). It picks the first free port in 20241-20245.
printf 'Waiting for the tunnel to connect'
ok=0
for _ in $(seq 1 30); do
  for p in 20241 20242 20243 20244 20245; do
    if curl -sf "http://127.0.0.1:$p/ready" >/dev/null 2>&1; then ok=1; break 2; fi
  done
  printf '.'; sleep 1
done
echo
if [ "$ok" -ne 1 ]; then
  echo "Tunnel is NOT connected. Check: journalctl -u cloudflared -n 50 --no-pager"
  echo "  wrong or rotated token -> re-run this script with a fresh token (dashboard: tunnel > Add a replica)"
  echo "  blocked network        -> allow outbound TCP and UDP 7844 (no UDP is fine; cloudflared falls back to http2)"
  exit 1
fi

# 6) End to end: this request leaves the server, goes to Cloudflare, and comes back in through the tunnel.
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$HOST/player" || true)"
case "$code" in
  200) echo "OK: https://$HOST/player answers through Cloudflare." ;;
  502) echo "Tunnel is up but cloudflared cannot reach the app on 127.0.0.1:8080 - check: systemctl status signage" ;;
  530) echo "Cloudflare cannot see the tunnel yet (error 1033) - wait a minute and re-check, then check the tunnel's Routes tab." ;;
  000) echo "https://$HOST does not answer yet - DNS may still be propagating; check DNS > Records for a Proxied CNAME '$HOST'." ;;
  *)   echo "https://$HOST/player returned HTTP $code - check the route (Service must be HTTP, http://127.0.0.1:8080)." ;;
esac

# Nothing to open in the firewall: cloudflared only makes outbound connections (TCP and UDP
# 7844 to Cloudflare). The ufw rule for 8080 stays for LAN use.

IP=$(hostname -I | awk '{print $1}')
echo
echo "Cloudflare Tunnel is installed and starts on every boot."
echo "  Public player:    https://$HOST/player"
echo "  Public dashboard: https://$HOST/        (password: ADMIN_PASSWORD in $ENV_FILE)"
echo "  LAN (unchanged):  http://$IP:8080/      <- use for uploads over 100 MB and for TVs from 2016 or older"
echo "  Tunnel status:    systemctl status cloudflared   |  logs: journalctl -u cloudflared -f"
echo "  Update:           apt-get update && apt-get install --only-upgrade cloudflared && systemctl restart cloudflared"
echo "  New token:        re-run this script            |  remove: sudo bash deploy/install-tunnel.sh --remove"
