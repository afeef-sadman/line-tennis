# Public Deployment Guide

Line Tennis is a single Node process (HTTP + WebSocket on one port). Two ways
to make invitation links work over the internet:

## Option 1 — Instant public tunnel (no account, already verified)

Uses Cloudflare's official `cloudflared` quick-tunnel tool. Free, HTTPS + WSS,
works worldwide immediately. Trade-off: your PC must stay on, and the URL
changes every time the tunnel restarts.

```powershell
# 1. Start the game server
npm install
npm start

# 2. In a second terminal, download cloudflared (once):
Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile deploy\cloudflared.exe

# 3. Start the tunnel
deploy\cloudflared.exe tunnel --url http://127.0.0.1:3000 --no-autoupdate
```

cloudflared prints a line like:

```
|  https://some-random-words.trycloudflare.com  |
```

Open that URL, create a room, and share the invitation link — it embeds the
public host automatically, so friends on any device/network can join.

macOS/Linux: `brew install cloudflared` (or download the matching release
binary), then `cloudflared tunnel --url http://127.0.0.1:3000`.

## Option 2 — Permanent cloud host (survives your PC being off)

The repo ships ready-made config for both major Node hosts. Pick one:

### Render (free tier available)
1. Push this folder to a GitHub repo (already done if you're reading this on GitHub).
2. Go to https://render.com/deploy/blueprints and sign in with GitHub.
3. Select the `line-tennis` repo. Render reads `render.yaml` and provisions
   the web service automatically (build `npm install`, start `npm start`,
   health check `/healthz`).
4. Click **Apply**. A few minutes later you get a permanent URL like
   `https://line-tennis.onrender.com`.

Note: Render's free tier sleeps after inactivity; the first visit wakes it
(~30 s). WebSockets are fully supported.

### Railway
1. Go to https://railway.com → New Project → Deploy from GitHub repo.
2. Select `line-tennis`. `railway.json` sets the start command and health check.
3. Settings → Networking → Generate Domain to get your public URL.

### Either host
- HTTPS is terminated by the platform; the client auto-upgrades to `wss:`.
- `PORT` is injected by the platform; the server already honors it.
- Rooms are in-memory: run exactly **one instance** (both configs do).
- Keep `LT_DEBUG` unset — it enables a QA-only cheat hook.

## Verify a deployment

```
curl https://YOUR-HOST/healthz        # {"ok":true,"rooms":0}
```

Then open the site in two different browsers/devices, create a room on one,
open the invite link on the other, and play. `npm test` runs the full local
physics + networking suites before you deploy.