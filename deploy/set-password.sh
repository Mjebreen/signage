#!/usr/bin/env bash
# Change the dashboard password on a server set up by deploy/install.sh:
#   sudo bash deploy/set-password.sh
# It asks for the new password (nothing is shown while you type, and nothing ends up in
# your shell history), keeps every other setting in the file, and restarts the service.
set -euo pipefail
ENV_FILE=/etc/signage/signage.env

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo"; exit 1; fi
if [ ! -f "$ENV_FILE" ]; then echo "$ENV_FILE not found. Run deploy/install.sh first."; exit 1; fi

read -rsp "New dashboard password: " PW; echo
read -rsp "Type it again:          " PW2; echo
if [ "$PW" != "$PW2" ]; then echo "They do not match. Nothing was changed."; exit 1; fi
if [ "${#PW}" -lt 8 ]; then echo "Use at least 8 characters. Nothing was changed."; exit 1; fi
# The value is written between single quotes, which systemd reads literally; that leaves
# the single quote itself as the one character that cannot be used.
case "$PW" in *"'"*) echo "The password cannot contain a ' character. Nothing was changed."; exit 1;; esac

TMP="$(mktemp "$ENV_FILE.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
grep -v '^[[:space:]]*ADMIN_PASSWORD=' "$ENV_FILE" > "$TMP" || true   # keep PUBLIC_URL and friends
printf "ADMIN_PASSWORD='%s'\n" "$PW" >> "$TMP"
chown root:root "$TMP"; chmod 600 "$TMP"
mv "$TMP" "$ENV_FILE"
trap - EXIT

systemctl restart signage
sleep 2
if ! systemctl is-active --quiet signage; then
  echo "signage did not come back up:"; journalctl -u signage -n 20 --no-pager; exit 1
fi
echo "Password changed. Everyone who was logged in has been logged out."
