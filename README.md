# ski-scrapers

Tiny Node.js microservice that handles Instagram and YouTube extraction
for the Ski Tools website. Lives on Railway because those two platforms
block Vercel's IPs.

> TikTok scraping is handled by a separate service the operator already
> runs — this one stays focused on IG + YT.

## Deploy to Railway

1. Push this folder to a new private GitHub repo.
2. In Railway: **New Project → Deploy from GitHub** → pick this repo.
3. **Variables**: add `SCRAPER_API_KEY` — paste the strong random string
   shared with Vercel. Railway sets `PORT` automatically; you don't need to.
4. Railway auto-detects Node, runs `npm install`, then `npm start`.
5. **Settings → Networking → Generate Domain** to get a public URL.

## Wire up Vercel

In the Vercel project for `skitools-site`, add two env vars:

```
SCRAPER_BASE_URL=https://<your-railway-domain>.up.railway.app
SCRAPER_API_KEY=<same-value-as-railway>
```

Redeploy the Vercel project and the `/api/instagram` and `/api/youtube`
routes will proxy through Railway. `/api/tiktok` keeps calling tikwm.com
directly (or your existing TikTok service).

## Local dev

```bash
npm install
SCRAPER_API_KEY=dev-secret node server.js
```

Then:

```bash
curl -X POST http://localhost:8080/instagram \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: dev-secret' \
  -d '{"url":"https://www.instagram.com/reel/<shortcode>/"}'
```

## Endpoints

All require `x-api-key` header. All accept JSON `{ url }`.

| Method | Path        | Returns |
|--------|-------------|---------|
| GET    | `/`         | health JSON |
| POST   | `/instagram`| `{ type, kind, media, cover, title, author }` |
| POST   | `/youtube`  | `{ type, videoId, title, video, videoHires, audio, ... }` |
