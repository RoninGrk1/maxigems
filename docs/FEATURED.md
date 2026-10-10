# Featured listings (sponsored spots)

**Product:** 1 SOL buys 24 hours in a clearly labelled gold **Sponsored** card pinned at the top of `/trending/`, plus
**one** channel post in @maxigems_calls labelled "Sponsored – not financial advice". Payments go to the treasury
`9dw32avaHbCsySNJNrwreV5onRTUubMpq88tp5XMwLMX` through the shared payments core (CONTRACT.md). **Payments stay disabled**
(`paymentsEnabled: false` in `site/config.js` + `PAYMENTS_ENABLED` unset on the functions). While disabled, the safety
check on `/featured/` works and the pay button reads "Coming soon".

## Flow
1. `/featured/`: paste a CA, then the public `featured` function (`{action:'check'}`) runs `validateFeaturedOrder`: valid
   32-byte base58 mint, a Solana pair on DexScreener, the engine's exact RugCheck hard rules (`_shared/safety-rules.js`),
   liquidity ≥ $20K and pair age ≥ 90 min (= `config.json` filters), not flagged rugged (RugCheck or MaxiGems
   `calls.json`), and not already featured or queued. Failure shows plain-English reasons and **no payment option**.
2. Pass shows a quote with the next available start, end and channel-post time. Then sign in and pay with `MGPay.payOrder({kind:'featured', ca})`.
   `create-order` re-runs the same check server-side.
3. `verify-payment` / `sweep` calls `fulfilFeatured`, which books the slot atomically in `public.featured_book()`
   (advisory lock, idempotent per order) and DMs the admin (8995645285) with the details and a **🛑 Pull listing** URL button.
4. Status page: `/featured/?ca=<CA>` (also the post's "Track & Share" target).

## Caps (featured-core.js `schedule()` == SQL `featured_book()`, checked by `npm run check:sql:featured`)
- Max **3** listings live at once. Extra bookings are waitlisted to the next free start.
- Max **1 sponsored channel post per 24h** across all listings, and each listing's post must land inside its own window
  (≥ 1h before it ends). A booking therefore starts no earlier than 1h after the previous post slot. **Effect:** with
  1 post/day, the steady state is about 1 new listing per day (≤ 2 overlapping), so the 3-slot cap only matters if
  `featured.maxPostsPerDay` in `config.json` (and `FEATURED_RULES.maxPostsPerDay`) is raised.

## Who does what
| piece | where |
|---|---|
| lifecycle queued → active → ended | `sweepFeatured` (cron, every 2 min) **and** the engine each run (idempotent) |
| the ONE sponsored post per listing | engine `src/featured.js` (same formatting/escaping as calls; re-checks safety first; strict 24h gap; stores `post_message_id`) |
| failed re-check before posting | no post; listing auto-pulled; admin DM; manual refund |
| public data | engine writes `site/data/featured.json` (active listings only; no wallets/order ids). The site filters by time too. |
| admin pull | `https://maxigems.fun/featured/admin/#<token>` → POST to the `featured` function (`admin-view` / `pull`) |

### Admin "Pull listing" link (no webhook)
The engine and other tools use `getUpdates`, so the bot must **not** get a webhook (a webhook disables `getUpdates`).
So the DM button is a plain **URL button** to a signed link, not `callback_data`:
`token = <listingId>.<expSeconds>.<base64url HMAC-SHA256(FEATURED_ADMIN_SECRET, "mg-featured:pull:<id>:<exp>")>`.
It's scoped to one listing and one action, and it expires at the end of the listing (max 72h). It sits in the URL
`#fragment`, so it never reaches a server log. Opening the page does nothing until you press **Pull listing**. A pull
sets `status='pulled'` and deletes the channel post when Telegram still allows it (bots can delete their own posts for 48h).
The card disappears at the next engine run (≤ 25 min). To mint a fresh link:
`FEATURED_ADMIN_SECRET=… node scripts/featured-admin-link.mjs <listing-id> [hours]`.

## Refunds
Manual, by design (shown in the UI and the Terms draft). Cases: pulled listing, failed pre-post re-check, or the coin
got booked by someone else between quote and payment (fulfilment marks the order done and DMs the admin "needs a manual refund").

## Setup still needed (not done: needs credentials/approval)
- Supabase: apply `supabase/migrations/20261010130000_featured.sql` (after the pro migration) and deploy the `featured`
  function. Both need a Supabase **personal access token** (or the SQL editor for the migration).
- Function secret `FEATURED_ADMIN_SECRET` (≥ 32 random chars). Optional `FEATURED_DRY_RUN=1` logs DMs instead of sending.
- GitHub Actions secrets `SUPABASE_SERVICE_ROLE_KEY` (+ optional `SUPABASE_URL`) and pass them to the engine step env,
  or the engine writes an empty `featured.json` and posts nothing.

## Tests
`node --test test/featured.test.js` · `npm run test:functions` (Deno) · `npm run check:sql:featured` (PGlite) ·
`PLAYWRIGHT_CORE=… node scripts/check-featured-ui.mjs` (headless 320/390/1280 + screenshots).
