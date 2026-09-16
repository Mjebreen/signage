# Signage

Self-hosted digital signage that runs entirely on your local network. One PC runs the
server; any TV with a web browser (Samsung Tizen browser included) is a player.
No internet, no accounts, no app installs on the TV.

## Run it

Double-click `start.bat`, or:

```
npm install
npm start
```

The console prints the dashboard and player addresses, for example:

```
Dashboard:  http://10.10.26.19:8080/
TV player:  http://10.10.26.19:8080/player
```

Set `PORT=9000` in the environment to use another port.

### Dashboard password

Set `ADMIN_PASSWORD` and the dashboard asks for it before showing anything. TVs never
need it: the player, its pairing code flow and media stay open. Without a password the
dashboard is open to anyone on your network, which is fine at home and not fine
anywhere else; the server refuses to start with `PUBLIC_URL` set and no password.

- Windows: uncomment the `set ADMIN_PASSWORD=...` line in `start.bat`.
- Linux (systemd): the installer generates one into `/etc/signage/signage.env`.

Logins last 30 days and survive restarts. Ten wrong guesses lock that client out for
15 minutes. Set `SESSION_SECRET` if you want to rotate sessions without changing the
password.

### Windows Firewall (once)

TVs can only reach the server if Windows allows inbound port 8080. In an **Administrator** PowerShell:

```
New-NetFirewallRule -DisplayName "LAN Signage" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
```

Give the server PC a fixed IP (DHCP reservation in your router) so the TV homepage never breaks.

## How it works

Two pages in the dashboard:

- **Library**: drop photos and videos here. You can also add a web page address.
- **Screens**: one card per TV. Click a card to choose its style (fullscreen or with a ticker bar),
  pick which photos it shows and in what order, seconds per photo, ticker text, and whether to show a clock.
  Save, and the TV updates by itself within a second.

Adding a TV: press **Add a TV**, open the player address in the TV browser, type the 6-letter
code the TV shows. Codes seen on the network appear as buttons so you can just click them.

## Samsung TV setup

1. Press **Home**, open the **Internet** app.
2. Type the player address, e.g. `http://10.10.26.19:8080/player`.
3. Pair it in the dashboard using the code on screen.
4. In the TV browser menu choose **Set as homepage** so one press brings the signage back.
5. In the browser menu choose **Full screen** to hide the address bar.
6. In TV settings disable **Auto Power Off / Eco sleep** and the screen saver.

Content tips for Samsung browsers:

- Images: JPG or PNG, 1920×1080 for fullscreen. AVIF, SVG, WEBP and HEIC often do not display
  on TVs; the Library marks those with a "may not play on TV" badge.
- Video: MP4 with H.264 video and AAC audio. Videos play muted (browser rule for autoplay).
- Web pages: anything on your LAN works. Public sites that forbid embedding show blank.
- A TV is recognised by an ID stored in its browser. Clearing browser data makes it ask to pair again.

If the server is unreachable when a TV boots, it replays its last cached configuration and keeps retrying.

## Files

- `server.js` – Express + WebSocket server and REST API.
- `lib/db.js` – JSON file store at `data/db.json` (or `$DATA_DIR/db.json`).
- `lib/auth.js` – dashboard password, session cookie, and the allow-list of player routes.
- `public/login.html` – the login page.
- `test/auth.test.js` – `npm test` starts the server and checks TVs stay open while the dashboard is closed.
- `data/media/` – uploaded files. Back up `data/` to keep everything.
- `public/index.html`, `app.js`, `style.css` – dashboard.
- `public/player.html`, `player.js` – TV player (plain ES5 for old TV browsers).

## API (for scripting)

With a password set, every endpoint below except the player ones needs the session
cookie from `POST /api/login` `{password}`.

- `GET /api/state` – media, screens, settings.
- `POST /api/media` (multipart `files`), `POST /api/media/web` `{name,url}`, `PATCH /api/media/:id`, `DELETE /api/media/:id`
- `POST /api/screens/claim` `{code,name}`
- `PUT /api/screens/:id` `{name, style: "full"|"ticker", items: [mediaId...], seconds, fit: "contain"|"cover", ticker, clock}`
- `DELETE /api/screens/:id`, `POST /api/screens/:id/reload`
- `PUT /api/settings` `{clockFormat: "24h"|"12h"}`
- `GET /player?screen=<id>` previews a screen in any browser without pairing.

## Hosting on a Linux server (recommended for 24/7 use)

The server only needs Node.js 18+. Data lives in `data/` (database + uploaded files).

### Option A: systemd (Debian / Ubuntu)

Copy the project folder to the server (everything except `node_modules`), then:

```
cd signage
sudo bash deploy/install.sh
```

The script installs Node.js if missing, copies the app to `/opt/signage`, creates a `signage`
service user, enables a systemd service that starts on boot, and opens port 8080 in ufw if active.

Day-to-day:

```
sudo systemctl status signage        # is it running
journalctl -u signage -f             # live logs
sudo systemctl restart signage       # after editing files in /opt/signage
```

Updating: copy the new files over and run `sudo bash deploy/install.sh` again. `data/` is never touched.

### Option B: Docker

```
docker compose up -d --build
```

Uploads and the database are kept in `./data` next to the compose file.

### After either option

- Give the server a fixed IP (DHCP reservation in the router).
- Point every TV browser at `http://<server-ip>:8080/player` and set it as the homepage.
- Back up the `data/` folder now and then.
