# Signage

Self-hosted digital signage that runs entirely on your local network. One PC runs the
server; any TV with a web browser (Samsung Tizen browser included) is a player.
No internet or accounts needed on the LAN, and no app installs on the TV. If you also want TVs
outside your network, a Cloudflare Tunnel adds a public https address (last section).

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

- Windows or any local run: create a file named `.env` next to `server.js` containing
  `ADMIN_PASSWORD=your-password`. It is git-ignored, and the server reads it however it is
  started. `deploy/signage.env.example` lists everything that can go in it.
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
  A TV that loads the player over https (the tunnel address) cannot show `http://` pages;
  the Library marks those. Use https addresses, or keep such TVs on the LAN address.
- A TV is recognised by an ID stored in its browser. Clearing browser data makes it ask to pair again.

If the server is unreachable when a TV boots, it replays its last cached configuration and keeps retrying.

## Portrait (9:16) and landscape (16:9) screens

Choose **Portrait** or **Landscape** when you pair a TV; you can change it later by
clicking the screen. The choice means *what a person looking at the screen sees*.

A TV hung on its side still believes it is a landscape TV, so its browser draws a sideways
page. The player knows this: when a screen is set to Portrait but the TV reports a wide
picture, the player turns everything itself (photos, videos, ticker and clock). A display
that really does report a tall picture is left alone. If the picture comes out upside down,
the TV was hung the other way round: tick **Picture upside down on the TV?** in that
screen's editor.

- The dashboard shows each screen the way it looks on the wall, and **Preview** opens it
  upright on your PC, whichever way the real TV is turned.
- Make portrait content **1080×1920** and landscape content **1920×1080**. A wide photo on
  a portrait screen shows with black bars unless *Fill the screen* is on; the editor marks
  such items `wide` or `tall`.
- The ticker bar is thinner on portrait screens, and the pairing code, ticker and clock are
  sized from the screen's short side, so text looks the same whichever way up the TV is.
- New TVs start from your last choice, so with mostly portrait screens the pairing code is
  upright on most of them straight away.

## Files

- `server.js` – Express + WebSocket server and REST API.
- `lib/db.js` – JSON file store at `data/db.json` (or `$DATA_DIR/db.json`).
- `lib/auth.js` – dashboard password, session cookie, and the allow-list of player routes.
- `public/login.html` – the login page.
- `test/auth.test.js` – `npm test` starts the server and checks TVs stay open while the dashboard is closed.
- `data/media/` – uploaded files. Back up `data/` to keep everything.
- `public/index.html`, `app.js`, `style.css` – dashboard.
- `public/player.html`, `player.js`, `player-layout.js` – TV player (plain ES5 for old TV
  browsers); `player-layout.js` is the portrait/landscape maths, shared with the tests.

## API (for scripting)

With a password set, every endpoint below except the player ones needs the session
cookie from `POST /api/login` `{password}`.

- `GET /api/state` – media, screens, settings.
- `POST /api/media` (multipart `files`), `POST /api/media/web` `{name,url}`, `PATCH /api/media/:id`, `DELETE /api/media/:id`
- `POST /api/screens/claim` `{code, name, orientation}`
- `PUT /api/screens/:id` `{name, style: "full"|"ticker", items: [mediaId...], seconds, fit: "contain"|"cover", ticker, clock, orientation: "portrait"|"landscape", flip}`
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

Updating: copy the new files over and run `sudo bash deploy/install.sh` again. It restarts the
service and checks that it answers; `data/` and your password are never touched.

### Option B: Docker

```
docker compose up -d --build
```

Uploads and the database are kept in `./data` next to the compose file.

### After either option

- Give the server a fixed IP (DHCP reservation in the router).
- Point every TV browser at `http://<server-ip>:8080/player` and set it as the homepage.
- Back up the `data/` folder now and then.

## Reach the TVs over the internet (Cloudflare Tunnel)

With a tunnel, TVs anywhere can load `https://signage.yourdomain.com/player` and the
dashboard is reachable from anywhere too. The server makes only outbound connections;
nothing is opened on your router. The LAN address keeps working exactly as before.

You need: a Cloudflare account with your domain added to it (free plan is fine), and the
Linux server already running signage through `deploy/install.sh`. The dashboard password is
mandatory once the server is public; the app refuses to start otherwise.

### 1. Create the tunnel in the Cloudflare dashboard (from your PC)

1. Log in at dash.cloudflare.com and open the account that holds your domain. Go to
   **Networking → Tunnels** (older accounts: **Zero Trust → Networks → Tunnels**). If it asks
   you to pick a Cloudflare One plan first, choose **Free**.
2. **Create a tunnel** → connector type **Cloudflared** → name it `signage` → **Create**.
3. On the *Install and run connectors* page pick **Debian / 64-bit** (or **arm64** for a Pi).
   Cloudflare shows `sudo cloudflared service install eyJ…`. **Do not run it there.** The long
   text starting with `eyJ` is your **tunnel token**; keep it private. (Get it back later via
   the tunnel → **Add a replica**.) Click **Next**.
4. **Routes → Add route → Published application**: Subdomain `signage`, Domain = your domain,
   Path empty, Service type **HTTP**, URL `http://127.0.0.1:8080`. Leave the additional
   settings at their defaults (do not enable HTTP/2 to origin). **Save**.
5. Check **DNS → Records** for a `signage` **CNAME** to `<id>.cfargotunnel.com` with the orange
   cloud (**Proxied**) on. The route normally creates it; add it yourself if it is missing.

### 2. Install it on the server

```
sudo bash deploy/install-tunnel.sh
```

It asks for the token and the hostname (`signage.yourdomain.com`), installs `cloudflared` from
Cloudflare's apt repository, records `PUBLIC_URL` for the app, installs the tunnel as a systemd
service that starts on boot, waits for it to connect, and finally fetches
`https://signage.yourdomain.com/player` through Cloudflare. It ends with `OK` when everything
works, or with a one-line hint about what to check. Prefer typing the token at the prompt
rather than passing it as an argument, which would leave it in your shell history.

Re-running the script is safe; it is also how you install a new token.

### 3. Test on each TV model you own

Open `https://signage.yourdomain.com/player` on the TV, pair it in the dashboard at
`https://signage.yourdomain.com/` and let a video play through at least one full loop.
Do this once per model year, because the TV's TLS support differs between years:

- **2016 and older**: cannot use the https address at all (no SNI support). Keep those TVs on
  the LAN address `http://<server-ip>:8080/player`.
- **2017 and newer**: expected to work, but Samsung documents only SNI and TLS 1.0–1.2, not
  the certificate type. If the page stays blank, shows a certificate error, or loads but the
  video never starts: in the dashboard go to **SSL/TLS → Edge Certificates → Order Advanced
  Certificate** (the Advanced Certificate Manager add-on works on the Free plan), choose
  **Google Trust Services** as the authority and include your hostname. It replaces the
  default ECDSA-only certificate for that hostname with one old TVs accept.

### 4. Cloudflare settings to check once

The player must never be shown a browser challenge or have scripts injected into it. The
paths the app leaves public are `/player`, `/player.js`, `/api/player/*`, `/media/*` and `/ws`;
keep these two rules in step with `lib/auth.js` if that list ever changes.

- **Security → Security rules → Custom rules → Create rule** named `Signage players - skip`,
  expression
  `(starts_with(http.request.uri.path, "/player") or starts_with(http.request.uri.path, "/api/player/") or starts_with(http.request.uri.path, "/media/") or http.request.uri.path eq "/ws")`,
  action **Skip**, ticking *All remaining custom rules*, *All rate limiting rules* and
  *All managed rules*. Move it to the top of the list.
- **Rules → Overview → Create rule → Configuration Rule** named `Signage players`, same
  expression: Browser Integrity Check **Off**, Security Level **Off**, Email Obfuscation **Off**,
  Rocket Loader **Off**, Disable Real User Monitoring **On**, Automatic HTTPS Rewrites **Off**.
- Confirm these zone-wide toggles: **Network → WebSockets** On. **Security → Settings**: Bot
  Fight Mode **Off** (it cannot be skipped by any rule and would blank every TV), Under Attack
  mode **Off**. **Speed → Rocket Loader** Off. **Security → Email Address Obfuscation** Off.
  **SSL/TLS → Edge Certificates → Minimum TLS Version** 1.0 or 1.2, never 1.3.
  Do not add the site to **Web Analytics** (it injects a script).

No cache rule is needed: the app sends `/media` as `private, no-transform`, so Cloudflare
proxies videos without caching them.

### What to expect

- Uploads through the public address are limited to **100 MB per file** by Cloudflare; the
  Library says so and skips bigger files. Upload large videos from the LAN address.
- Playback has no size limit; videos of any size stream through the tunnel. Cloudflare's terms
  for the free CDN frown on heavy video traffic, so keep TVs that are on the LAN on the LAN
  address, and consider Cloudflare R2/Stream if usage grows.
- TVs and the dashboard reconnect automatically when Cloudflare restarts an edge server or
  when you restart the tunnel; expect a few seconds of "offline".
- At boot without internet, `systemctl status cloudflared` shows *failed* and keeps retrying
  every few seconds until the connection comes up. That is normal.
- Anonymous registrations are limited to 30 per minute per client, and TVs that showed a
  pairing code but never paired are forgotten after ten minutes.

### Day to day

```
systemctl status cloudflared          # tunnel status
journalctl -u cloudflared -f          # tunnel logs
sudo apt-get update && sudo apt-get install --only-upgrade cloudflared && sudo systemctl restart cloudflared
sudo bash deploy/install-tunnel.sh    # install a new token (dashboard: tunnel > Rotate token)
sudo bash deploy/install-tunnel.sh --remove   # take the tunnel off this server
```

Security notes: the token in `/etc/cloudflared/token` (root-only) is the tunnel's only
credential, so rotate it if it ever leaks; `cloudflared` runs as root, as Cloudflare's own
installer sets it up, and only talks to `127.0.0.1:8080`; the dashboard is protected by the
app password alone, so use a long one; the admin API paths are deliberately not in the skip
rule, so Cloudflare's protections still apply to them. Set `BIND_ADDRESS=127.0.0.1` in
`/etc/signage/signage.env` if the server should be reachable through the tunnel only.
