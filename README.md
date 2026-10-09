# 💎 MaxiGems — automated Solana memecoin calls

An automated Telegram call channel **plus** a one-page live tracker website, running 100% on **free APIs and free hosting**.

- **Engine** (`src/`, Node 20, zero dependencies): scans Solana pairs on DexScreener + GeckoTerminal every 10 min, filters out rugs/weak coins, scores the rest, posts the best to Telegram, and tracks every call's **peak x since call**.
- **Telegram**: rich HTML posts (token image, CA in `<code>`, stats, DexScreener/Solscan/Birdeye/Photon/BullX links, inline buttons for Chart / Solscan / Jupiter / Birdeye / site), **milestone replies** (2x, 3x, 5x…) and a **top-performers recap** every 12h.
- **Website** (`site/`, static, no build): black / neon-green / electric-blue glass UI, Telegram button under the header, live feed with search, DEX filter, sort, copy-CA, stats bar, auto-refresh. Mobile-first.
- **Automation**: GitHub Actions cron (every 10 min) runs the engine, commits `calls.json`, and deploys the site to GitHub Pages — free for public repos.

## Free APIs used (no keys)
| API | Endpoint | Used for |
|---|---|---|
| DexScreener | `/token-boosts/latest/v1`, `/token-boosts/top/v1`, `/token-profiles/latest/v1` | discovery |
| DexScreener | `/tokens/v1/solana/{up to 30 CAs}` | pair data (price, MC, liq, vol, txns, change) + tracking |
| GeckoTerminal | `/networks/solana/trending_pools`, `/networks/solana/new_pools` (2 pages each) | discovery |
| Telegram Bot API | `sendPhoto` / `sendMessage` | posting |

Requests are spaced per host (DexScreener ≥1.1 s, GeckoTerminal ≥2.5 s), with retries + backoff on 429/5xx. A run uses ~15 requests.

## Setup (public repo + GitHub Pages)

1. **Bot** `@Maxigems_bot` (from @BotFather) is an admin of channel **@maxigems_calls** with *Post Messages*.
2. **Repo** (public — unlimited free Actions minutes + free Pages) → *Settings → Secrets and variables → Actions*:
   - Secrets: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID` = `@maxigems_calls`
   - Variables: `DRY_RUN` (`1` = print only, still tracks + commits data; set `0` or delete to **go live**), `SITE_URL` = `https://maxigems.fun/`, optional `TELEGRAM_CHANNEL_URL`
   - *Settings → Actions → General → Workflow permissions*: **Read and write**.
3. *Settings → Pages → Source: **GitHub Actions***, custom domain **maxigems.fun** (also in `site/CNAME`).
   Cloudflare DNS for `maxigems.fun` (Proxy status **DNS only**, grey cloud, at least until GitHub issues the certificate):
   | Type | Name | Content |
   |---|---|---|
   | A | `@` | 185.199.108.153 |
   | A | `@` | 185.199.109.153 |
   | A | `@` | 185.199.110.153 |
   | A | `@` | 185.199.111.153 |
   | AAAA (optional) | `@` | 2606:50c0:8000::153 / 8001::153 / 8002::153 / 8003::153 |
   | CNAME | `www` | roningrk1.github.io |
   Then, once the certificate is issued, tick *Settings → Pages → Enforce HTTPS*.
4. *Actions → "MaxiGems engine + site" → Run workflow* (tick *Dry run* to test). The cron then runs every 10 min: engine → data commit → Pages deploy. Edits to `site/` deploy on push.

> GitHub may delay cron runs at busy times and disables schedules after 60 days without repo activity (the bot's data commits count as activity). Making the repo private would cap Actions at 2,000 min/month and disable free Pages.

**Go live:** set repo variable `DRY_RUN` to `0` (or delete it). That's it.

### Alternative hosting
- **Vercel / Netlify / Cloudflare Pages** also work for `site/` (static, root directory `site`, no build).
- **VPS / always-on box**: `cp .env.example .env`, fill it in, then
  ```bash
  set -a; . ./.env; set +a
  npm start            # loop mode, every loopIntervalMinutes (default 10)
  ```
  Use `pm2 start "npm start" --name maxigems` or a systemd unit to keep it alive. Serve `site/` with any web server.

## Commands
| Command | What |
|---|---|
| `npm run dry` | one run, prints Telegram messages instead of sending (`DRY_RUN=1`) |
| `npm run once` | one real run |
| `npm start` | loop forever (VPS) |
| `npm run recap` | force a top-performers recap |
| `npm run serve` | preview the site at http://localhost:8080 |
| `npm test` | unit + end-to-end tests (mocked APIs, no network) |

Without a bot token the engine runs in **site-only mode** (calls are recorded for the website, nothing posted).

## Filters & scoring (`config.json`)
| Setting | Default | Meaning |
|---|---|---|
| `minLiquidityUsd` / `maxLiquidityUsd` | 25,000 / 3,000,000 | depth range (0 liq = rug) |
| `minMarketCapUsd` / `maxMarketCapUsd` | 40k / 25M | gem range |
| `minVolume24hUsd` / `minVolume1hUsd` | 30k / 3k | must be trading now |
| `minAgeMinutes` / `maxAgeHours` | 120 / 168 | skip the first-hour dump zone (4 of 5 early rugs were < 1h old) |
| `minTxnsH1` | 80 | real activity |
| `minPriceChangeM5` / `maxPriceChangeM5` | −15% / +25% | no calls into a 5-min dump or spike |
| `minBuySellRatioH1` | 1.05 | more buys than sells |
| `minPriceChangeH1` / `maxPriceChangeH1` | −8% / +150% | not dumping, not a vertical top |
| `minPriceChangeH24` / `maxPriceChangeH24` | −30% / +1500% | |
| `minLiquidityToMcapRatio` | 0.08 | thin-liquidity pump guard |
| `maxFdvToMcapRatio` | 1.5 | hidden-supply guard |
| `allowedDexes` | pumpswap, pumpfun, raydium, meteora, meteoradbc, launchlab, orca | |
| `preferredDexes` | pumpswap, pumpfun, raydium, meteora(dbc) | +4 score |
| `blockedSymbols` | SOL, USDC, USDT, JUP, BONK, WIF… | never "call" majors |
| `minScore` | 65 | 0–100 score threshold |
| `maxCallsPerRun` / `maxCallsPerDay` | 2 / 16 | anti-spam |
| `milestones` | 2,3,5,10,20,50,100 | reply under the original call when peak x crosses these |
| `recap.everyHours` / `topN` / `minMultiple` | 12 / 5 / 1.2 | recap post |

**Score (0–100)** = liquidity depth 15 + volume/liquidity turnover 15 + buy/sell flow 20 + price momentum (5m/1h/6h) 20 + tx activity 15 + volume acceleration (1h vs 24h avg) 15, plus bonuses (preferred DEX, socials, boosted, seen on several sources) and penalties for overextension.

### On-chain safety (stage 2, fail-closed)
Only the best `safety.maxChecksPerRun` (8) market-passing tokens are checked, to stay inside free rate limits:
1. **GeckoTerminal** `pools/multi` → unique buyers in the last hour: ≥ `minUniqueBuyersH1` (60) and unique buyers ÷ buys ≥ `minBuyerDiversityH1` (0.2, catches bot wash). Skipped if GT returns nothing.
2. **RugCheck** `api.rugcheck.xyz/v1/tokens/{mint}/report` (free, keyless) — reject if: mint or freeze authority not revoked · LP locked/burned < `minLpLockedPct` (90%; pump.fun/PumpSwap migrated pools report 100%) · top-10 holders excl. pools/AMMs/lockers > `maxTop10HolderPct` (30%) · flagged insiders > `maxInsiderPct` (10%) · creator holds > `maxCreatorPct` (5%) · insider network > 20% of holders · < `minHolders` (300) · any RugCheck risk at level `danger` · transfer fee · flagged rugged.
3. **Solana public RPC** `getMultipleAccounts` (one batched call) cross-checks mint/freeze authority.
If RugCheck can't be read for a token, it is **not called** (fail closed). Posts and site cards show `🛡 Mint ✅ | Freeze ✅ | LP 🔥 100% | Top10 18%`.

**Rug detection** for posted calls: marked **Rugged** (sticky, red badge on the site, excluded from "Best performer", still counted in avg/hit-rate) when price is down ≥ 80% from call or liquidity down ≥ 70% from call (`rugDetection`). No Telegram rug alerts.

**Tracking**: each run refreshes all calls from the last `trackDays` (7) using the same pair. `athMultiple` = highest price *observed* (sampled each run) ÷ call price; a call whose liquidity falls below $1k is flagged "Liquidity pulled". Dedupe is by contract address (`data/state.json` → `seen`, kept 30 days; set `requoteCooldownHours` > 0 to allow re-calls).

## Files
```
config.json                 thresholds + channel/site/chat (telegramChatUrl → 💬 Chat button on posts) settings
src/index.js                CLI (--once | --loop | --recap)
src/engine.js               run cycle: track → discover → filter/score → post → persist
src/sources.js              DexScreener + GeckoTerminal clients
src/scoring.js              metrics, rug filters, score
src/format.js               Telegram HTML templates (all values escaped)
src/telegram.js             Bot API client (429 retry_after, fallbacks, DRY_RUN)
src/state.js / util.js      atomic JSON state, fetch w/ rate-limit, formatters
data/state.json             engine state (committed by the Action)
site/                       static website (index.html, config.js, assets/, data/calls.json)
.github/workflows/maxigems.yml   10-min cron: engine + data commit + Pages deploy
test/                       node:test suites
```

## Branding
- Header avatar: `site/assets/avatar-96.{webp,png}` (ape-head crop for legibility at 40px); full logo `site/assets/logo-{128,512}.{webp,png}`.
- Favicons `site/favicon.ico|-16|-32.png`, `apple-touch-icon.png` (180), `icon-192/512.png`, `site.webmanifest`.
- Link previews: `site/assets/og-image.jpg` (1200×630). The deploy job rewrites `og:image`/`twitter:image` to absolute URLs using `SITE_URL` (or the Pages URL).
- Telegram: `branding/telegram-fallback.jpg` is uploaded as the photo for calls without a token image and for recaps (`telegram.fallbackPhoto` in `config.json`).
- `branding/telegram-avatar.png` (640×640) — set it as the channel/bot photo by hand (Channel → Edit → photo; @BotFather → /setuserpic).

## Security notes
- Secrets live only in GitHub Secrets / `.env` (git-ignored). Logs never print the token.
- Token names/symbols are attacker-controlled: stripped of control/RTL chars, length-capped, HTML-escaped for Telegram; the site renders with `textContent` only, rebuilds all links from validated Solana addresses, whitelists image hosts, and ships a strict CSP.

*Not financial advice. Memecoins are extremely risky.*
