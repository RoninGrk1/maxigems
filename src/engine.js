// One engine cycle: track existing calls → discover → filter/score → post → persist → export site data.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverCandidates, fetchPairs, pickPair, fetchUniqueTraders } from './sources.js';
import { checkSafety } from './safety.js';
import { metrics, filterReasons, score } from './scoring.js';
import { callMessage, callButtons, milestoneMessage, recapMessage, links } from './format.js';
import { postMessage, telegramConfigured } from './telegram.js';
import { readJson, writeJsonAtomic, emptyState, normalizeState } from './state.js';
import { cleanText, safeUrl, num, log, sleep, fmtX } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PATHS = {
  config: process.env.MAXIGEMS_CONFIG || path.join(ROOT, 'config.json'),
  state: process.env.MAXIGEMS_STATE || path.join(ROOT, 'data', 'state.json'),
  site: process.env.MAXIGEMS_SITE_DATA || path.join(ROOT, 'site', 'data', 'calls.json'),
};

const DAY = 86400000;

/** Local logo uploaded as the photo for calls without a token image and for recaps. */
export function fallbackPhoto(cfg) {
  const p = cfg?.telegram?.fallbackPhoto;
  return p ? path.resolve(ROOT, p) : null;
}

export function loadConfig() {
  const cfg = readJson(PATHS.config, null);
  if (!cfg) throw new Error(`config not found/invalid: ${PATHS.config}`);
  if (process.env.SITE_URL) cfg.siteUrl = process.env.SITE_URL;
  if (process.env.TELEGRAM_CHANNEL_URL) cfg.telegramChannelUrl = process.env.TELEGRAM_CHANNEL_URL;
  return cfg;
}

function postingMode(cfg) {
  if (/^(1|true|yes)$/i.test(process.env.DRY_RUN ?? '')) return 'dry';
  return telegramConfigured(cfg) ? 'live' : 'off';
}

/** Sticky rug flag: price down ≥X% from call, or liquidity down ≥Y% from call (or < $1k). */
export function isRugged(c, rd = {}) {
  const priceDrop = rd.priceDropPct ?? 80, liqDrop = rd.liquidityDropPct ?? 70;
  if (c.status === 'rugged') return true;
  const x = num(c.currentMultiple);
  if (x !== null && x <= 1 - priceDrop / 100) return true;
  const l0 = num(c.liquidity), l1 = num(c.currentLiquidity);
  if (l1 !== null && l1 < 1000) return true;
  if (l0 && l1 !== null && l1 <= l0 * (1 - liqDrop / 100)) return true;
  return false;
}

function buildCall(m, sc, now, safety = null, traders = null) {
  const ca = m.address;
  return {
    id: `${ca}-${now}`,
    chain: 'solana',
    address: ca,
    name: cleanText(m.name, 40) || cleanText(m.symbol, 20),
    symbol: cleanText(m.symbol, 16).replace(/^\$/, ''),
    dex: m.dex,
    pairAddress: m.pairAddress,
    imageUrl: safeUrl(m.imageUrl),
    calledAt: new Date(now).toISOString(),
    score: sc,
    priceAtCall: m.priceUsd,
    mcAtCall: m.marketCap,
    fdvAtCall: m.fdv,
    liquidity: m.liquidity,
    volume24h: m.vol24,
    volume1h: m.vol1,
    change: { m5: m.chM5, h1: m.chH1, h6: m.chH6, h24: m.chH24 },
    buysH1: m.buysH1,
    sellsH1: m.sellsH1,
    ageMsAtCall: m.ageMs,
    pairCreatedAt: m.pairCreatedAt ? new Date(m.pairCreatedAt).toISOString() : null,
    links: links(ca, m.pairAddress),
    safety,
    uniqueBuyersH1: traders?.buyersH1 ?? null,
    // tracking
    currentPrice: m.priceUsd,
    currentMc: m.marketCap,
    currentLiquidity: m.liquidity,
    currentMultiple: 1,
    athPrice: m.priceUsd,
    athMc: m.marketCap,
    athMultiple: 1,
    athAt: new Date(now).toISOString(),
    status: 'active',
    milestonesHit: [],
    lastUpdated: new Date(now).toISOString(),
    tg: { posted: false, messageId: null },
  };
}

/** Refresh live price / ATH multiple for recent calls. Returns list of {call, milestone}. */
async function trackCalls(state, cfg, now) {
  const active = state.calls.filter((c) => now - Date.parse(c.calledAt) < (cfg.trackDays ?? 7) * DAY);
  if (!active.length) return [];
  const pairsMap = await fetchPairs(active.map((c) => c.address));
  const hits = [];
  const milestones = cfg.milestones ?? [2, 3, 5, 10, 20, 50, 100];
  for (const c of active) {
    const p = pickPair(pairsMap.get(c.address), c.pairAddress);
    if (!p) continue; // API miss: keep previous values rather than zeroing
    const price = num(p.priceUsd);
    const liq = num(p.liquidity?.usd);
    if (price === null || price <= 0 || !c.priceAtCall) continue;
    c.currentPrice = price;
    c.currentMc = num(p.marketCap) ?? num(p.fdv) ?? c.currentMc;
    c.currentLiquidity = liq;
    c.currentMultiple = +(price / c.priceAtCall).toFixed(4);
    if (price > (c.athPrice ?? 0)) {
      c.athPrice = price;
      c.athMc = c.currentMc;
      c.athAt = new Date(now).toISOString();
    }
    c.athMultiple = +(c.athPrice / c.priceAtCall).toFixed(4);
    if (c.status !== 'rugged' && isRugged(c, cfg.rugDetection)) {
      c.status = 'rugged';
      c.ruggedAt = new Date(now).toISOString();
      log(`RUG detected $${c.symbol} (x${c.currentMultiple}, liq ${liq})`); // site only, no Telegram alert
    }
    c.lastUpdated = new Date(now).toISOString();
    const hit = c.status === 'rugged' ? [] : milestones.filter((x) => c.athMultiple >= x && !c.milestonesHit.includes(x));
    if (hit.length) {
      c.milestonesHit.push(...hit);
      hits.push({ call: c, milestone: Math.max(...hit) });
    }
  }
  return hits;
}

export async function runOnce({ forceRecap = false } = {}) {
  const cfg = loadConfig();
  const f = cfg.filters;
  const now = Date.now();
  const mode = postingMode(cfg);
  log(`MaxiGems run start (telegram mode: ${mode})`);
  if (mode === 'off') log('NOTE TELEGRAM_BOT_TOKEN (or channel id) not set → site-only mode (no posts).');

  const state = normalizeState(readJson(PATHS.state, emptyState()));

  // 1) track existing calls
  const milestoneHits = await trackCalls(state, cfg, now);

  // 2) discover + enrich
  const cands = await discoverCandidates();
  const fresh = cands.filter((c) => {
    const seenAt = state.seen[c.address];
    if (!seenAt) return true;
    const cd = (cfg.requoteCooldownHours ?? 0) * 3600000;
    return cd > 0 && now - seenAt > cd;
  });
  log(`candidates: ${cands.length} unique, ${fresh.length} not yet called`);
  const pairsMap = await fetchPairs(fresh.map((c) => c.address));

  const scored = [];
  const rejectStats = {};
  for (const c of fresh) {
    const pair = pickPair(pairsMap.get(c.address));
    if (!pair) { rejectStats['no pair data'] = (rejectStats['no pair data'] ?? 0) + 1; continue; }
    const m = metrics(pair, now);
    const reasons = filterReasons(m, f);
    if (reasons.length) {
      for (const r of reasons) rejectStats[r] = (rejectStats[r] ?? 0) + 1;
      continue;
    }
    const sc = score(m, f, c);
    if (sc < f.minScore) { rejectStats[`score<${f.minScore}`] = (rejectStats[`score<${f.minScore}`] ?? 0) + 1; continue; }
    scored.push({ m, sc });
  }
  scored.sort((a, b) => b.sc - a.sc);
  const marketPassed = scored.length;
  const last24 = state.calls.filter((c) => now - Date.parse(c.calledAt) < DAY).length;
  const dailyLeft = Math.max(0, (cfg.maxCallsPerDay ?? 16) - last24);
  const want = Math.min(cfg.maxCallsPerRun ?? 2, dailyLeft);
  if (!dailyLeft) log(`daily cap reached (${last24} calls in 24h)`);

  // Stage 2 (only for the best few, to respect free rate limits): unique traders + on-chain safety
  const shortlist = want > 0 ? scored.slice(0, cfg.safety?.maxChecksPerRun ?? 8) : [];
  const bump = (r) => (rejectStats[r] = (rejectStats[r] ?? 0) + 1);
  const traders = shortlist.length ? await fetchUniqueTraders(shortlist.map((x) => x.m.pairAddress)) : new Map();
  const stage2 = [];
  for (const x of shortlist) {
    const t = traders.get(x.m.pairAddress);
    x.traders = t ?? null;
    if (t) { // only enforce when GeckoTerminal returned data
      if (t.buyersH1 < (f.minUniqueBuyersH1 ?? 0)) { bump('few unique buyers'); continue; }
      if (t.buysH1 > 0 && t.buyersH1 / t.buysH1 < (f.minBuyerDiversityH1 ?? 0)) { bump('low buyer diversity (bots?)'); continue; }
    }
    stage2.push(x);
  }
  const passed = [];
  if (cfg.safety?.enabled === false) passed.push(...stage2);
  else {
    const res = await checkSafety(stage2.map((x) => ({ address: x.m.address, pairAddress: x.m.pairAddress })), cfg.safety ?? {});
    for (const x of stage2) {
      const r = res.get(x.m.address);
      if (!r || r.reasons.length) {
        for (const reason of r?.reasons ?? ['safety: unchecked']) bump(reason.replace(/[\d.]+%|\d+$/g, '').trim());
        log(`SAFETY reject $${x.m.symbol}: ${(r?.reasons ?? ['unchecked']).join('; ')}`);
        continue;
      }
      x.safety = r.safety;
      passed.push(x);
    }
  }
  const picks = passed.slice(0, want);
  log('rejections:', JSON.stringify(rejectStats));
  log(`pass rate: ${fresh.length} fresh → ${marketPassed} market filters → ${shortlist.length} shortlisted → ${stage2.length} trader check → ${passed.length} safety → calling ${picks.length}`);

  // 3) post new calls
  let tgBroken = false;
  const delay = cfg.telegram?.delayBetweenPostsMs ?? 3500;
  const newCalls = [];
  for (const { m, sc, safety, traders: tr } of picks) {
    const call = buildCall(m, sc, now, safety, tr);
    if (mode !== 'off' && !tgBroken) {
      try {
        const r = await postMessage({ html: callMessage(call, cfg), photo: call.imageUrl, fallbackPhoto: fallbackPhoto(cfg), buttons: callButtons(call, cfg), cfg });
        call.tg = { posted: mode === 'live', messageId: r?.result?.message_id ?? null };
        if (mode === 'live') await sleep(delay);
      } catch (e) {
        log(`ERROR telegram post failed for ${call.symbol}: ${e.message}`);
        if ([400, 401, 403, 404].includes(e.status)) tgBroken = true; // config problem: stop hammering
      }
    }
    state.seen[call.address] = now;
    newCalls.push(call);
    log(`CALL $${call.symbol} score=${sc} mc=${call.mcAtCall} liq=${call.liquidity} ${call.links.dexscreener}`);
  }
  state.calls = [...newCalls, ...state.calls];

  // 4) milestone updates (reply to original call)
  if (mode !== 'off' && !tgBroken) {
    for (const { call, milestone } of milestoneHits.slice(0, 5)) {
      try {
        await postMessage({ html: milestoneMessage(call, call.athMultiple, cfg), replyTo: call.tg?.messageId, buttons: callButtons(call, cfg), cfg });
        log(`MILESTONE $${call.symbol} ${fmtX(call.athMultiple)} (>= ${milestone}x)`);
        if (mode === 'live') await sleep(delay);
      } catch (e) {
        log(`ERROR milestone post failed: ${e.message}`);
      }
    }
  }

  // 5) periodic recap
  const rc = cfg.recap ?? {};
  const due = forceRecap || (rc.enabled && (!state.lastRecapAt || now - Date.parse(state.lastRecapAt) >= (rc.everyHours ?? 12) * 3600000));
  if (due && mode !== 'off' && !tgBroken) {
    const days = cfg.trackDays ?? 7;
    const top = state.calls
      .filter((c) => c.status !== 'rugged' && now - Date.parse(c.calledAt) < days * DAY && (c.athMultiple ?? 0) >= (rc.minMultiple ?? 1.2))
      .sort((a, b) => b.athMultiple - a.athMultiple)
      .slice(0, rc.topN ?? 5);
    if (top.length) {
      try {
        await postMessage({ html: recapMessage(top, days * 24, cfg), photo: fallbackPhoto(cfg), cfg });
        state.lastRecapAt = new Date(now).toISOString();
      } catch (e) {
        log(`ERROR recap failed: ${e.message}`);
      }
    } else log('recap due but no performers above threshold yet');
  }

  // 6) persist (cap sizes, prune old dedupe keys after 30d)
  state.calls = state.calls.slice(0, cfg.maxCallsStored ?? 100);
  for (const [k, t] of Object.entries(state.seen)) if (now - t > 30 * DAY) delete state.seen[k];
  state.lastRunAt = new Date(now).toISOString();
  writeJsonAtomic(PATHS.state, state);
  writeJsonAtomic(PATHS.site, siteData(state, cfg, now));
  log(`done: ${newCalls.length} new, ${state.calls.length} stored, ${milestoneHits.length} milestones`);
  return { newCalls, milestoneHits, state, rejectStats, passRate: { fresh: fresh.length, market: marketPassed, safety: passed.length } };
}

export function siteData(state, cfg, now = Date.now()) {
  const pub = state.calls.map((c) => ({
    address: c.address, name: c.name, symbol: c.symbol, chain: c.chain, dex: c.dex, pairAddress: c.pairAddress,
    imageUrl: c.imageUrl, calledAt: c.calledAt, score: c.score,
    priceAtCall: c.priceAtCall, mcAtCall: c.mcAtCall, liquidity: c.liquidity, volume24h: c.volume24h, change: c.change,
    currentPrice: c.currentPrice, currentMc: c.currentMc, currentLiquidity: c.currentLiquidity,
    currentMultiple: c.currentMultiple, athMultiple: c.athMultiple, athMc: c.athMc, status: c.status,
    safety: c.safety ? { mint: c.safety.mintRevoked, freeze: c.safety.freezeRevoked, lp: c.safety.lpLockedPct, top10: c.safety.top10Pct } : null,
    links: c.links, lastUpdated: c.lastUpdated,
  }));
  return {
    updatedAt: new Date(now).toISOString(),
    telegramChannelUrl: cfg.telegramChannelUrl,
    count: pub.length,
    calls: pub,
  };
}
