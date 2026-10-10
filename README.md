# 💎 MaxiGems — automated Solana memecoin calls

An automated Telegram call channel **plus** a one-page live tracker website, running 100% on **free APIs and free hosting**.

- **Engine** (`src/`, Node 20, zero dependencies): scans Solana pairs on DexScreener + GeckoTerminal every 10 min, filters out rugs/weak coins, scores the rest, posts the best to Telegram, and tracks every call's **peak x since call**.
- **Telegram**: rich HTML posts (token image, CA in `<code>`, stats, DexScreener/Solscan/Birdeye/Photon/BullX links, inline buttons for Chart / Solscan / Jupiter / Birdeye / site), **milestone replies** (2x, 3x, 5x…) and a **top-performers recap** every 12h.
- **Website** (`site/`, static, no build): black / neon-green / electric-blue glass UI, Telegram button under the header, live feed with search, DEX filter, sort, copy-CA, stats bar, auto-refresh. Mobile-first.
- **Share cards**: every call gets `/c/<CA>/` (branded page with OG/Twitter meta, live numbers, copy CA, share sheet) and a 1200×630 `card.png` rendered in the engine (`src/share.js`, @resvg/resvg-js + sharp, Inter font in `fonts/`, OFL). Cards re-render only when peak x moves ≥ 0.05 or status changes (max 25 per run, catches up later); pages are rewritten only when they change; render state lives in `data/share.json`; `sitemap.xml` lists every coin page. Share sheet (X, Telegram, Discord copy-link, save image, copy link, native share) on Calls, Leaderboard, coin pages and called coins on Trending. Telegram posts link to the coin page.
- **Pages**: `/` live calls, `/trending/` trending, `/leaderboard/` track record (period toggle 24h/7d/30d/All, 2x/5x/10x hit rates, avg/median peak x, rug rate incl. rugged calls, podium, sortable/searchable table, peak-x bar chart). Shared header nav + buttons (`site/assets/common.js`, `styles.css`), clean folder URLs, `sitemap.xml`, `robots.txt`, branded `404.html`.
- **Automation**: GitHub Actions cron (every 10 min) runs the engine, commits `calls.json`, and deploys the site to GitHub Pages — free for public repos.

## Trending Radar (`/trending/`)
Live "what's moving on Solana" page, fetched **in the visitor's browser** (all endpoints send `Access-Control-Allow-Origin: *`):
DexScreener `token-boosts/top|latest/v1` + `tokens/v1/solana/{≤30 CAs}` (every 60 s, ≤4 batches) and GeckoTerminal
`trending_pools` + `new_pools` (every ~2 min, 5-min back-off after a failure). Tabs: **🔥 Hot now** (heat = 5m/1h volume
acceleration + buyers + buy share), **🎓 New graduates** (pump.fun mints on PumpSwap/Raydium < 24h), **👀 On watch**
(`site/data/watchlist.json`). If the APIs fail it shows `site/data/trending.json`. Each engine run writes both files from data
it already fetched (`src/radar.js`, no extra requests). Page logic: `site/assets/radar-core.js` (pure, unit-tested) +
`trending.js`, styles in `trending.css`. Not calls — DYOR.

## Whale Watcher (`/whales/`)
**Top 15 whales** across MaxiGems-called coins (non-rugged, inside the 7-day tracking window) ranked by USD held, a **whale
moves** feed (🟢 bought more / 🔴 sold / 🚪 exited / 🆕 new top holder, last 200), a **Top holders** block on every `/c/<CA>/`
page, and a client-side **holder lookup** for any Solana CA.

* **Data (engine, `src/whales.js` + pure core `site/assets/whales-core.js`):** the safety check's RugCheck report gives a new
  call its baseline holder list (no extra request). Every run re-reads the exact balances of all tracked top-holder token
  accounts with batched `getMultipleAccounts` (Solana public RPC, PublicNode fallback). New top holders are discovered on a
  rotating batch (`whales.holdersPerRun`, default 10 coins/run → each coin every ~3 runs): RPC `getTokenLargestAccounts` when the
  public endpoint allows it, else RugCheck. Discovered accounts are re-read on-chain before use (RugCheck lists can lag).
* **Excluded:** RugCheck known accounts (AMM / pool / locker / CLOB…), market vault accounts, the pair, the mint, a curated
  deny-list (burn, launchpad fee and well-known CEX hot wallets — best effort) and every **program-owned** owner (off the ed25519
  curve = PDA: pool authorities, bonding curves, lockers, escrows). Insider flags come from RugCheck, dev = token creator.
* **Diff rules:** the first snapshot of a coin is a baseline (no events, no alerts). A holder absent from the new list was
  re-read on-chain, so "exited" means the balance really is ~0. "New" sizes are a conservative minimum (holding − previous
  cut-off, shown as ≥). Feed keeps moves ≥ 0.1 % of supply or ≥ $2.5k (and ≥ $100).
* **Telegram alerts (`whales.alerts`):** top-10 holder of the coin or global top-15 whale, sell/exit or buy of **≥ 1 % of supply
  AND ≥ $5k**; insider/dev **sells** from 0.25 % / $1k. Moves on one coin are batched into one message, posted as a reply to the
  coin's call (standalone if unknown) with Track & Share + Whales buttons. Max **1 alert per coin per hour, 6 per rolling 24 h**;
  DRY_RUN prints them. Caps only count alerts that were actually posted.
* **Files:** `site/data/whales.json` (top 15 + per-coin top 10 holders), `site/data/whale-moves.json` (feed),
  `data/holders.json` (engine snapshots + alert log). All compact JSON.
* **Lookup (browser):** RugCheck `/v1/tokens/{CA}/report` (CORS *) for the holder list + labels, balances re-checked on
  `solana-rpc.publicnode.com` (CORS *, ≤10 accounts/call), price from DexScreener. `api.mainnet-beta.solana.com` returns 403 to
  browsers and `getTokenLargestAccounts` needs a key on every free browser RPC, so RugCheck is the list source; 429s are retried
  once, input is base58-validated, lookups are spaced ≥ 4 s.
* **Limits:** a wallet moving tokens to its own second wallet looks like a sell + new holder; CEX/market-maker wallets not in
  the deny-list or RugCheck labels can appear; holders are only the top ~20 accounts per coin.

## Free APIs used (no keys)
| API | Endpoint | Used for |
|---|---|---|
| DexScreener | `/token-boosts/latest/v1`, `/token-boosts/top/v1`, `/token-profiles/latest/v1` | discovery |
| DexScreener | `/tokens/v1/solana/{up to 30 CAs}` | pair data (price, MC, liq, vol, txns, change) + tracking |
| GeckoTerminal | `/networks/solana/trending_pools`, `/networks/solana/new_pools` (2 pages each) | discovery |
| RugCheck | `/v1/tokens/{mint}/report` | safety check, whale baseline/discovery, browser lookup |
| Solana RPC | `getMultipleAccounts`, `getTokenLargestAccounts` (public RPC; PublicNode fallback) | authorities, whale balances |
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
| `minLiquidityUsd` / `maxLiquidityUsd` | 20,000 / 3,000,000 | depth range (0 liq = rug) |
| `minMarketCapUsd` / `maxMarketCapUsd` | 40k / 25M | gem range |
| `minVolume24hUsd` / `minVolume1hUsd` | 30k / 2.4k | must be trading now |
| `minAgeMinutes` / `maxAgeHours` | 90 / 168 | skip the first-hour dump zone (4 of 5 early rugs were < 1h old) |
| `minTxnsH1` | 60 | real activity |
| `minPriceChangeM5` / `maxPriceChangeM5` | −20% / +35% | no calls into a 5-min dump or spike |
| `minBuySellRatioH1` | 0.85 | no heavy sell pressure |
| `minPriceChangeH1` / `maxPriceChangeH1` | −8% / +200% | not dumping, not a vertical top |
| `minPriceChangeH24` / `maxPriceChangeH24` | −30% / +1500% | |
| `minLiquidityToMcapRatio` | 0.06 | thin-liquidity pump guard |
| `maxFdvToMcapRatio` | 1.5 | hidden-supply guard |
| `allowedDexes` | pumpswap, pumpfun, raydium, meteora, meteoradbc, launchlab, orca | |
| `preferredDexes` | pumpswap, pumpfun, raydium, meteora(dbc) | +4 score |
| `blockedSymbols` | SOL, USDC, USDT, JUP, BONK, WIF… | never "call" majors |
| `minScore` | 60 | 0–100 score threshold |
| `maxCallsPerRun` / `maxCallsPerDay` | 3 / 45 | anti-spam |
| `milestones` | 2,3,5,10,20,50,100 | reply under the original call when peak x crosses these |
| `recap.everyHours` / `topN` / `minMultiple` | 12 / 5 / 1.2 | recap post |

**Score (0–100)** = liquidity depth 15 + volume/liquidity turnover 15 + buy/sell flow 20 + price momentum (5m/1h/6h) 20 + tx activity 15 + volume acceleration (1h vs 24h avg) 15, plus bonuses (preferred DEX, socials, boosted, seen on several sources) and penalties for overextension.

### On-chain safety (stage 2, fail-closed)
Only the best `safety.maxChecksPerRun` (12) market-passing tokens are checked, to stay inside free rate limits:
1. **GeckoTerminal** `pools/multi` → unique buyers in the last hour: ≥ `minUniqueBuyersH1` (45) and unique buyers ÷ buys ≥ `minBuyerDiversityH1` (0.15, catches bot wash). Skipped if GT returns nothing.
2. **RugCheck** `api.rugcheck.xyz/v1/tokens/{mint}/report` (free, keyless) — reject if: mint or freeze authority not revoked · LP locked/burned < `minLpLockedPct` (80%; pump.fun/PumpSwap migrated pools report 100%) · top-10 holders excl. pools/AMMs/lockers > `maxTop10HolderPct` (35%) · flagged insiders > `maxInsiderPct` (15%) · creator holds > `maxCreatorPct` (8%) · insider network > 25% of holders · < `minHolders` (200) · any RugCheck risk at level `danger` · transfer fee · flagged rugged.
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
src/whales.js               Whale Watcher: holder snapshots, diffs, moves feed, alerts (core: site/assets/whales-core.js)
src/telegram.js             Bot API client (429 retry_after, fallbacks, DRY_RUN)
src/state.js / util.js      atomic JSON state, fetch w/ rate-limit, formatters
data/state.json             engine state (committed by the Action)
data/holders.json           whale holder snapshots + alert log (committed by the Action)
site/                       static website (index.html, leaderboard/, trending/, whales/, 404.html, sitemap.xml, robots.txt, config.js, assets/, data/calls.json)
site/assets/leaderboard-core.js  pure leaderboard maths (median, rates, periods, ranking) — unit-tested in test/leaderboard.test.js
.github/workflows/maxigems.yml   10-min cron: engine + data commit + Pages deploy
test/                       node:test suites
```

## Branding
- Header avatar: `site/assets/avatar-96.{webp,png}` (ape-head crop for legibility at 40px); full logo `site/assets/logo-{128,512}.{webp,png}`.
- Favicons `site/favicon.ico|-16|-32.png`, `apple-touch-icon.png` (180), `icon-192/512.png`, `site.webmanifest`.
- Link previews: `site/assets/og-image.jpg` (1200×630). Each page carries absolute `https://maxigems.fun/...` canonical, `og:url` and `og:image` tags (update them if the domain changes).
- Telegram: `branding/telegram-fallback.jpg` is uploaded as the photo for calls without a token image and for recaps (`telegram.fallbackPhoto` in `config.json`).
- `branding/telegram-avatar.png` (640×640) — set it as the channel/bot photo by hand (Channel → Edit → photo; @BotFather → /setuserpic).

## Security notes
- Secrets live only in GitHub Secrets / `.env` (git-ignored). Logs never print the token.
- Token names/symbols are attacker-controlled: stripped of control/RTL chars, length-capped, HTML-escaped for Telegram; the site renders with `textContent` only, rebuilds all links from validated Solana addresses, whitelists image hosts, and ships a strict CSP.

*Not financial advice. Memecoins are extremely risky.*

## Tips (SOL)

The tip address lives in one place: `tipAddress` in `site/config.js`. After changing it run `npm run build:tip`. That validates the address (32-byte base58), regenerates `site/assets/tip-qr.svg` (Solana Pay URI `solana:<address>?label=MaxiGems&message=Tip%20for%20MaxiGems`) and the tip card on the static pages. Coin pages get a compact tip section on every engine run. Telegram call posts never include tipping. `test/tip.test.js` fails if the pages or QR are out of date, and it decodes the QR to check the exact URI.
