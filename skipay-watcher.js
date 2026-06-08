/**
 * SkiPay watcher — polls the Tron blockchain every N seconds for USDT
 * transfers arriving at our master wallet address, then notifies the
 * Vercel /api/skipay/match endpoint so it can credit users / mint
 * license keys.
 *
 * Stateless across restarts. Idempotency lives on the Vercel side:
 * /api/skipay/match uses tx_hash as a unique key and refuses to
 * double-credit.
 *
 * Required env vars:
 *   SKIPAY_TRON_ADDRESS       — the master USDT-TRC20 receive address
 *   SKIPAY_INTERNAL_SECRET    — HMAC-SHA256 secret (matches Vercel)
 *   SKITOOLS_API_BASE         — e.g. "https://skitools.app"
 *
 * Optional:
 *   SKIPAY_POLL_INTERVAL_MS   — default 20000 (20s)
 *   SKIPAY_LOOKBACK_SECONDS   — default 1800 (30 min) — how far back
 *                                to scan recent TXs on each poll
 *   TRONGRID_API_KEY          — optional; lifts rate limits
 */

import crypto from "node:crypto";

const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const MASTER_ADDR = process.env.SKIPAY_TRON_ADDRESS || "";
const HMAC_SECRET = process.env.SKIPAY_INTERNAL_SECRET || "";
const SITE_BASE   = (process.env.SKITOOLS_API_BASE || "").replace(/\/$/, "");
const POLL_MS     = Number(process.env.SKIPAY_POLL_INTERVAL_MS) || 20_000;
const LOOKBACK_S  = Number(process.env.SKIPAY_LOOKBACK_SECONDS) || 1800;
const TG_KEY      = process.env.TRONGRID_API_KEY || "";

// In-memory dedupe: tx hashes we've already forwarded this process's
// lifetime. Stops us from spamming /confirm during the lookback window.
// Vercel side also enforces idempotency by tx_hash, so this is just an
// optimisation.
const seenTxs = new Map(); // txHash → timestamp

function configured() {
  return MASTER_ADDR && HMAC_SECRET && SITE_BASE;
}

function logSkipayConfigStatus() {
  if (!configured()) {
    console.warn(
      "[skipay-watcher] DISABLED — missing one of: SKIPAY_TRON_ADDRESS, SKIPAY_INTERNAL_SECRET, SKITOOLS_API_BASE",
    );
    return;
  }
  console.log(
    `[skipay-watcher] watching ${MASTER_ADDR.slice(0, 6)}…${MASTER_ADDR.slice(-4)} every ${POLL_MS}ms; forwarding to ${SITE_BASE}/api/skipay/match`,
  );
}

/** Pull the most recent USDT-TRC20 transfers TO our master address. */
async function fetchRecentTransfers() {
  const minTs = Date.now() - LOOKBACK_S * 1000;
  const url =
    `https://api.trongrid.io/v1/accounts/${MASTER_ADDR}/transactions/trc20` +
    `?only_to=true&limit=50&contract_address=${USDT_TRC20_CONTRACT}` +
    `&min_timestamp=${minTs}`;

  const r = await fetch(url, {
    headers: TG_KEY ? { "TRON-PRO-API-KEY": TG_KEY } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) {
    throw new Error(`TronGrid ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const json = await r.json();
  return Array.isArray(json?.data) ? json.data : [];
}

/** Convert TronGrid TX to a normalised inbound payment object. */
function normaliseTx(tx) {
  // TRC20 amount comes in raw 6-decimal integer form for USDT.
  // e.g. 5420000 → 5.42 USDT
  const raw = String(tx.value || "0");
  const amountUsdt = Number(raw) / 1_000_000;
  return {
    txHash:        tx.transaction_id,
    fromAddress:   tx.from,
    toAddress:     tx.to,
    amountUsdt,
    blockTimestamp: Number(tx.block_timestamp || 0),
    tokenInfo:     tx.token_info?.symbol || "USDT",
  };
}

/** Sign + POST a confirmed-payment notification to Vercel. */
async function notifyVercel(tx) {
  const payload = {
    tx_hash:           tx.txHash,
    paid_amount_usdt:  tx.amountUsdt,
    from_address:      tx.fromAddress,
    to_address:        tx.toAddress,
    block_timestamp:   tx.blockTimestamp,
    confirmations:     20,                  // TronGrid only shows confirmed TXs
  };
  // Vercel side matches by expected amount; we just send the raw tx info
  // and let it find the right order.
  const matchEndpoint = `${SITE_BASE}/api/skipay/match`;
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", HMAC_SECRET).update(raw).digest("hex");

  const r = await fetch(matchEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-skipay-sig": sig,
    },
    body: raw,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

async function tickOnce() {
  if (!configured()) return;
  let txs;
  try {
    txs = await fetchRecentTransfers();
  } catch (err) {
    console.error("[skipay-watcher] TronGrid fetch failed:", err?.message || err);
    return;
  }

  const now = Date.now();
  // Drop seen-txs older than 24h to bound memory.
  for (const [h, ts] of seenTxs) {
    if (now - ts > 24 * 3600 * 1000) seenTxs.delete(h);
  }

  for (const raw of txs) {
    const tx = normaliseTx(raw);
    if (!tx.txHash || tx.toAddress !== MASTER_ADDR) continue;
    if (seenTxs.has(tx.txHash)) continue;
    seenTxs.set(tx.txHash, now);

    try {
      const result = await notifyVercel(tx);
      if (result.ok) {
        console.log(
          `[skipay-watcher] matched ${tx.amountUsdt} USDT tx=${tx.txHash.slice(0, 10)}… → ${JSON.stringify(result.data).slice(0, 100)}`,
        );
      } else if (result.status === 404) {
        // No pending order at this amount — could be a legit transfer that
        // isn't tied to an order. Log once and move on.
        console.log(
          `[skipay-watcher] no order matches ${tx.amountUsdt} USDT (tx=${tx.txHash.slice(0, 10)}…)`,
        );
      } else {
        console.warn(
          `[skipay-watcher] /match returned ${result.status}: ${JSON.stringify(result.data).slice(0, 160)}`,
        );
      }
    } catch (err) {
      console.error(
        `[skipay-watcher] notify failed for tx=${tx.txHash}: ${err?.message || err}`,
      );
    }
  }
}

/** Hit the Vercel expire endpoint to release stale pending orders.
 *  We run this from Railway because Vercel Hobby plan caps crons at 1/day. */
async function expireStaleOrders() {
  if (!configured()) return;
  const cronSecret = process.env.CRON_SECRET || "";
  if (!cronSecret) return; // skip silently if not configured
  try {
    const r = await fetch(`${SITE_BASE}/api/cron/skipay-expire`, {
      method: "GET",
      headers: { authorization: `Bearer ${cronSecret}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      console.warn(`[skipay-watcher] expire endpoint returned ${r.status}`);
    }
  } catch (err) {
    console.error("[skipay-watcher] expire call failed:", err?.message || err);
  }
}

export function startSkipayWatcher() {
  logSkipayConfigStatus();
  if (!configured()) return;

  // Run once immediately on boot, then on interval.
  tickOnce().catch((err) => console.error("[skipay-watcher] first tick failed:", err));
  setInterval(() => {
    tickOnce().catch((err) => console.error("[skipay-watcher] tick failed:", err));
  }, POLL_MS);

  // Expire stale orders every 5 minutes.
  expireStaleOrders().catch(() => {});
  setInterval(() => {
    expireStaleOrders().catch(() => {});
  }, 5 * 60 * 1000);
}
