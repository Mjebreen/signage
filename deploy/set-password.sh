#!/usr/bin/env bash
# Change the dashboard password on a server set up by deploy/install.sh:
#   sudo bash deploy/set-password.sh
# It asks for the new password (nothing is shown while you type, and nothing ends up in
# your shell history), keeps every other setting in the file, and restarts the service.
set -euo pipefail
ENV_FILE=/etc/signage/signage.env

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo"; exit 1; fi
if [ ! -f "$ENV_FILE" ]; then echo "$ENV_FILE not found. Run deploy/install.sh first."; exit 1; fi

# IFS= keeps the line exactly as typed; plain "read" would quietly trim spaces
IFS= read -rsp "New dashboard password: " PW; echo
IFS= read -rsp "Type it again:          " PW2; echo
if [ "$PW" != "$PW2" ]; then echo "They do not match. Nothing was changed."; exit 1; fi
if [ "${#PW}" -lt 8 ]; then echo "Use at least 8 characters. Nothing was changed."; exit 1; fi
# The value is written between single quotes, which systemd reads literally; that leaves
# the single quote itself as the one character that cannot be used.
case "$PW" in *"'"*) echo "The password cannot contain a ' character. Nothing was changed."; exit 1;; esac
case "$PW" in [[:space:]]*|*[[:space:]]) echo "The password cannot start or end with a space (a stray one from copy and paste?). Nothing was changed."; exit 1;; esac
case "$PW" in *[[:cntrl:]]*) echo "The password contains a key that is not a character (an arrow key?). Nothing was changed."; exit 1;; esac

cp -p "$ENV_FILE" "$ENV_FILE.bak"
TMP="$(mktemp "$ENV_FILE.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
grep -v '^[[:space:]]*ADMIN_PASSWORD=' "$ENV_FILE" > "$TMP" || true   # keep PUBLIC_URL and friends
printf "ADMIN_PASSWORD='%s'\n" "$PW" >> "$TMP"
chown root:root "$TMP"; chmod 600 "$TMP"
mv "$TMP" "$ENV_FILE"
trap - EXIT

put_back() {
  mv "$ENV_FILE.bak" "$ENV_FILE"; systemctl restart signage || true
  journalctl -u signage -n 20 --no-pager || true
  exit 1
}
systemctl restart signage || { echo "signage did not restart, so the old settings were put back:"; put_back; }
# "Running" is not enough: the point is that the server now asks for THIS password. Ask the
# app itself whether a password is in force, and go back to the old file if it is not.
state=unknown
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  body="$(curl -fsS --max-time 3 http://127.0.0.1:8080/api/session 2>/dev/null || true)"
  case "$body" in
    *'"authRequired":true'*)  state=on;  break;;
    *'"authRequired":false'*) state=off; break;;
  esac
done
if [ "$state" = off ]; then
  echo "The server came back WITHOUT a password (the new value could not be read), so the old settings were put back:"; put_back
fi
if ! systemctl is-active --quiet signage; then
  echo "signage did not come back up, so the old settings were put back:"; put_back
fi
rm -f "$ENV_FILE.bak"
if [ "$state" = on ]; then echo "Password changed. Everyone who was logged in has been logged out."
else echo "Password saved and the service is running, but it did not answer on 127.0.0.1:8080 to confirm."; fi
