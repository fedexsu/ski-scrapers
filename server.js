/**
 * Ski Scrapers — Railway-hosted Instagram + YouTube extractor.
 *
 * Why this exists:
 *   Instagram and YouTube block Vercel's IPs (because so many people scrape
 *   from there). Railway IPs are less abused, so they get through. This
 *   service runs the scraping work and is called from the Vercel website.
 *
 * Endpoints:
 *   POST /instagram { url }   →  { type, kind, media, cover, title, author }
 *   POST /youtube   { url }   →  { type, videoId, title, video, audio, ... }
 *
 * TikTok is handled by a separate Railway service (the one already running
 * for face-swap / tiktok). This service does NOT duplicate it.
 *
 * Auth:
 *   Every request must include `x-api-key: <SCRAPER_API_KEY>` matching the
 *   env var. Stops the public from hammering the endpoints directly.
 */

import express from "express";
import ytdl from "@distube/ytdl-core";
import youtubedl from "youtube-dl-exec";

const PORT = Number(process.env.PORT) || 8080;
const API_KEY = process.env.SCRAPER_API_KEY || "";

const app = express();
app.use(express.json({ limit: "32kb" }));

// ---- Auth + CORS ----------------------------------------------------- //

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    // No key configured = open service. Refuse so we don't run wide open
    // by accident when someone forgets to set the env var.
    return res.status(503).json({ error: "Scraper not configured" });
  }
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Bad x-api-key" });
  }
  next();
}

// ---- Health ---------------------------------------------------------- //

app.get("/", (_req, res) =>
  res.json({ ok: true, service: "ski-scrapers", uptime: process.uptime() }),
);

// ---- Instagram ------------------------------------------------------- //

const IG_RE =
  /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels|tv|stories\/[^/]+)\/([A-Za-z0-9_-]+)/i;

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

app.post("/instagram", requireApiKey, async (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!url || !IG_RE.test(url)) {
    return res.status(400).json({ error: "Not an Instagram URL" });
  }
  const shortcode = url.match(IG_RE)[1];
  const isReel = /\/(reel|reels|tv)\//i.test(url);

  // yt-dlp first — it has a native Instagram extractor with multiple
  // fallback strategies (mobile API, embed page, public profile API).
  const fromYtDlp = await tryYtDlpInstagram(url);
  if (fromYtDlp) return res.json(fromYtDlp);

  // Mirror sites as fallback when yt-dlp is rate-limited.
  const racers = [
    trySnapinsta(url),
    trySnapsave(url),
    tryIgram(url),
    tryDirectIG(shortcode),
  ];

  let best = null;
  const results = await Promise.allSettled(racers);
  for (const r of results) {
    if (r.status !== "fulfilled" || !r.value) continue;
    const out = r.value;
    if (out.video || (out.image && !isReel)) {
      if (!best) best = out;
      else if (isReel && !best.video && out.video) best = out;
    }
  }

  if (best && (best.video || best.image)) {
    const isVideo = !!best.video;
    return res.json({
      type: "instagram",
      kind: isVideo ? "video" : "image",
      media: best.video || best.image,
      cover: best.cover || best.video || best.image,
      title: (best.title || "").replace(/ on Instagram.*$/, "").trim(),
      author: best.author || "",
    });
  }

  return res.status(502).json({
    error:
      "Instagram is blocking us right now. Try a different post, or wait a couple minutes and retry.",
  });
});

async function tryYtDlpInstagram(url) {
  try {
    const meta = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      addHeader: ["referer:instagram.com", `user-agent:${IPHONE_UA}`],
    });
    // yt-dlp returns either a single video or a "playlist" for carousels.
    const single = meta.entries?.[0] || meta;
    const video = single.url || single.formats?.find((f) => f.ext === "mp4")?.url;
    const image = !video ? single.thumbnail || single.url : null;
    if (!video && !image) return null;
    return {
      type: "instagram",
      kind: video ? "video" : "image",
      media: video || image,
      cover: single.thumbnail || video || image,
      title: (single.title || single.description || "").replace(/ on Instagram.*$/, "").trim(),
      author: single.uploader || single.channel || "",
    };
  } catch (e) {
    console.error("[ig yt-dlp] failed:", e?.stderr?.slice(0, 200) || e?.message || e);
    return null;
  }
}

async function trySnapinsta(igUrl) {
  for (const endpoint of [
    "https://snapinsta.io/api/ajaxSearch",
    "https://snapinsta.app/api/ajaxSearch",
  ]) {
    try {
      const origin = new URL(endpoint).origin;
      const r = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent": CHROME_UA,
          Origin: origin,
          Referer: origin + "/",
          Accept: "*/*",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: new URLSearchParams({ q: igUrl, t: "media", lang: "en" }).toString(),
      });
      if (!r.ok) continue;
      const data = await r.json().catch(() => null);
      const html = data?.data || data?.html || "";
      if (!html) continue;
      const found = parseIGHtml(html);
      if (found) return found;
    } catch {
      // try next
    }
  }
  return null;
}

async function trySnapsave(igUrl) {
  try {
    const r = await fetchWithTimeout("https://snapsave.app/action.php?lang=en", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": CHROME_UA,
        Origin: "https://snapsave.app",
        Referer: "https://snapsave.app/",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: new URLSearchParams({ url: igUrl }).toString(),
    });
    if (!r.ok) return null;
    const data = await r.json().catch(() => null);
    const html = data?.data || data?.html || "";
    if (!html) return null;
    return parseIGHtml(html);
  } catch {
    return null;
  }
}

async function tryIgram(igUrl) {
  try {
    const r = await fetchWithTimeout("https://api.igram.world/api/v1/instagram/post", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": CHROME_UA,
        Origin: "https://igram.world",
        Referer: "https://igram.world/",
      },
      body: JSON.stringify({ url: igUrl }),
    });
    if (!r.ok) return null;
    const data = await r.json().catch(() => null);
    const item =
      (Array.isArray(data?.items) && data.items[0]) ||
      (Array.isArray(data?.data) && data.data[0]) ||
      data?.result?.[0];
    if (!item) return null;
    const mediaUrl = item.url || item.video || item.image || item.dl || item.download;
    if (!mediaUrl) return null;
    const isVideo = /\.mp4(\?|$)/i.test(mediaUrl) || item.type === "video";
    return {
      video: isVideo ? mediaUrl : undefined,
      image: !isVideo ? mediaUrl : undefined,
      cover: item.thumb || item.thumbnail || item.cover || mediaUrl,
      author: item.owner || item.username || item.author || "",
      title: item.caption || item.title || "",
    };
  } catch {
    return null;
  }
}

async function tryDirectIG(shortcode) {
  // From a Railway IP, the Instagram embed page often works directly.
  try {
    const r = await fetchWithTimeout(
      `https://www.instagram.com/p/${shortcode}/embed/captioned/`,
      {
        headers: {
          "User-Agent": IPHONE_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
    );
    if (!r.ok) return null;
    const html = await r.text();
    const video =
      html.match(/"video_url":"([^"]+)"/)?.[1] ||
      html.match(/property="og:video"\s+content="([^"]+)"/)?.[1] ||
      html.match(/(https?:\/\/[^"'<>\\\s]+\.fbcdn\.net[^"'<>\\\s]+\.mp4[^"'<>\\\s]*)/)?.[1];
    const image =
      html.match(/"display_url":"([^"]+)"/)?.[1] ||
      html.match(/property="og:image"\s+content="([^"]+)"/)?.[1];
    const author = html.match(/"username":"([^"]+)"/)?.[1];
    const title = html.match(/property="og:title"\s+content="([^"]+)"/)?.[1];
    if (!video && !image) return null;
    return {
      video: video ? decode(video) : undefined,
      image: image ? decode(image) : undefined,
      cover: image ? decode(image) : undefined,
      author,
      title,
    };
  } catch {
    return null;
  }
}

function parseIGHtml(html) {
  const found = {};
  const videos = [];
  const images = [];

  let m;
  const linkRe = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const url = decode(m[1]);
    if (!url.startsWith("http")) continue;
    if (/\.mp4(\?|$)/i.test(url) || /type=video/i.test(url)) videos.push(url);
    else if (
      /\.(jpg|jpeg|png|webp)(\?|$)/i.test(url) &&
      /cdninstagram|fbcdn|scontent/i.test(url)
    )
      images.push(url);
  }

  const dataRe = /(?:data-href|data-url|data-src)=["']([^"']+\.mp4[^"']*)["']/gi;
  while ((m = dataRe.exec(html)) !== null) videos.push(decode(m[1]));

  const inline = html.match(/https?:\/\/[^"'<>\\\s]+\.mp4[^"'<>\\\s]*/gi);
  if (inline) {
    for (const url of inline) {
      if (/cdninstagram|fbcdn|scontent|dms\.api/i.test(url)) videos.push(decode(url));
    }
  }

  if (videos.length) found.video = videos[0];
  if (images.length) found.image = images[0];

  const author =
    html.match(/<h2[^>]*>\s*@?([\w._]+)\s*<\/h2>/i)?.[1] ||
    html.match(/"username"\s*:\s*"([^"]+)"/)?.[1] ||
    html.match(/data-username=["']([^"']+)["']/i)?.[1];
  if (author) found.author = author;

  const caption =
    html.match(/<p[^>]+class=["'][^"']*caption[^"']*["'][^>]*>([^<]+)<\/p>/i)?.[1] ||
    html.match(/<title>([^<]+)<\/title>/i)?.[1];
  if (caption) found.title = caption.trim();

  found.cover = images[0] || videos[0];
  return found.video || found.image ? found : null;
}

// ---- YouTube --------------------------------------------------------- //

const YT_RE =
  /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i;

app.post("/youtube", requireApiKey, async (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!url) return res.status(400).json({ error: "Missing url" });
  const m = url.match(YT_RE);
  if (!m) return res.status(400).json({ error: "Not a YouTube URL" });
  const videoId = m[1];
  const canonical = `https://www.youtube.com/watch?v=${videoId}`;

  // Try yt-dlp first — it's massively more reliable than ytdl-core for
  // platforms that block cloud IPs (uses multiple player-extraction
  // strategies, web/android/ios clients, auto-rotates around blocks).
  const ytDlpOut = await tryYtDlp(canonical);
  if (ytDlpOut) return res.json({ ...ytDlpOut, videoId });

  // Last resort: ytdl-core (lighter, but breaks more often).
  try {
    const info = await ytdl.getInfo(canonical, {
      requestOptions: { headers: { "User-Agent": CHROME_UA } },
    });
    const details = info.videoDetails;
    const muxed = info.formats
      .filter((f) => f.hasVideo && f.hasAudio && f.container === "mp4")
      .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));
    const videoOnly = info.formats
      .filter((f) => f.hasVideo && !f.hasAudio && f.container === "mp4")
      .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));
    const audioOnly = info.formats
      .filter((f) => !f.hasVideo && f.hasAudio)
      .sort((a, b) => (Number(b.audioBitrate) || 0) - (Number(a.audioBitrate) || 0));
    const bestMuxed = muxed[0];
    const bestAudio = audioOnly[0];
    const highRes = videoOnly[0];

    return res.json({
      type: "youtube",
      videoId,
      title: details.title,
      author: details.author?.name || details.ownerChannelName || "",
      thumbnail:
        details.thumbnails?.[details.thumbnails.length - 1]?.url ||
        `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      duration: Number(details.lengthSeconds) || 0,
      video: bestMuxed?.url || null,
      videoQuality: bestMuxed?.qualityLabel || null,
      videoHires: highRes?.url || null,
      videoHiresQuality: highRes?.qualityLabel || null,
      audio: bestAudio?.url || null,
      audioBitrate: bestAudio?.audioBitrate || null,
    });
  } catch (err) {
    const msg = err?.message || String(err);
    if (/Video unavailable|Sign in to confirm|Private video/i.test(msg)) {
      return res
        .status(502)
        .json({ error: "Video is private, age-restricted, or region-blocked." });
    }
    console.error("[youtube] both extractors failed:", msg);
    return res
      .status(502)
      .json({ error: "Couldn't fetch that video — YouTube is blocking from this region. Try a different video." });
  }
});

/** yt-dlp wrapper — much more robust against YouTube/Instagram blocks
 *  than ytdl-core. yt-dlp is the same engine the rest of the open-source
 *  world relies on and is updated weekly. */
async function tryYtDlp(url) {
  // YouTube's `web` client is heavily protected on cloud IPs — gets the
  // "Sign in to confirm you're not a bot" wall. These alt clients use
  // different signing and aren't blocked from datacenter IPs as aggressively.
  // We try several in order and use whichever returns formats first.
  const playerClients = [
    "mweb",                  // mobile web — usually works
    "ios",                   // iOS app client
    "android_vr",            // VR client — almost never blocked
    "tv_embedded",           // embedded TV player
    "web_safari",            // Safari user-agent web client
  ];

  for (const client of playerClients) {
    try {
      const meta = await youtubedl(url, {
        dumpSingleJson: true,
        noWarnings: true,
        noCheckCertificates: true,
        preferFreeFormats: true,
        extractorArgs: `youtube:player_client=${client}`,
        addHeader: ["referer:youtube.com", `user-agent:${CHROME_UA}`],
      });
      const out = formatYtDlpMeta(meta);
      if (out && (out.video || out.audio)) {
        console.log(`[yt-dlp] success via ${client}`);
        return out;
      }
    } catch (e) {
      const err = e?.stderr?.toString().slice(0, 200) || e?.message || String(e);
      console.warn(`[yt-dlp] ${client} failed:`, err.slice(0, 160));
      // Try the next client.
    }
  }
  return null;
}

function formatYtDlpMeta(meta) {
  if (!meta) return null;
  try {
    const formats = Array.isArray(meta.formats) ? meta.formats : [];
    const muxed = formats
      .filter((f) => f.ext === "mp4" && f.acodec !== "none" && f.vcodec !== "none")
      .sort((a, b) => (b.height || 0) - (a.height || 0));
    const videoOnly = formats
      .filter((f) => f.ext === "mp4" && f.acodec === "none" && f.vcodec !== "none")
      .sort((a, b) => (b.height || 0) - (a.height || 0));
    const audioOnly = formats
      .filter((f) => f.acodec !== "none" && f.vcodec === "none")
      .sort((a, b) => (b.abr || 0) - (a.abr || 0));
    const bestMuxed = muxed[0];
    const highRes = videoOnly[0];
    const bestAudio = audioOnly[0];
    return {
      type: "youtube",
      title: meta.title || "",
      author: meta.uploader || meta.channel || "",
      thumbnail: meta.thumbnail || "",
      duration: Number(meta.duration) || 0,
      video: bestMuxed?.url || null,
      videoQuality: bestMuxed?.format_note || (bestMuxed ? `${bestMuxed.height}p` : null),
      videoHires: highRes?.url || null,
      videoHiresQuality: highRes?.format_note || (highRes ? `${highRes.height}p` : null),
      audio: bestAudio?.url || null,
      audioBitrate: bestAudio?.abr ? Math.round(bestAudio.abr) : null,
    };
  } catch (e) {
    console.error("[yt-dlp format] failed:", e?.message || e);
    return null;
  }
}

// NOTE: TikTok is handled by a separate Railway service the user already
// runs. Don't duplicate it here — that scraper service stays in charge of
// TikTok. The Vercel /api/tiktok route either calls tikwm.com directly
// (default) or can be repointed at the existing service if needed.

// ---- shared helpers -------------------------------------------------- //

async function fetchWithTimeout(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function decode(s) {
  return s
    .replace(/\\u0026/g, "&")
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\\"/g, '"');
}

// ---- start ----------------------------------------------------------- //

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[ski-scrapers] listening on :${PORT}`);
  if (!API_KEY) console.warn("[ski-scrapers] WARN: SCRAPER_API_KEY not set — service refusing requests");
});
