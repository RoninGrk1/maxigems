# MaxiGems shared payments/auth contract (branch `pro`)

Owner: **pro** worker (Pro pass + shared core). Consumer: **featured** worker (`/workspace/maxigems-featured`, branch `featured`,
rebases onto `pro`). Payments ship **disabled** (`PAYMENTS_ENABLED` unset/false on the server, `paymentsEnabled: false` in
`site/config.js`). Nothing here is deployed yet.

## Prices (single source: `supabase/functions/_shared/plans.js`)
| item | SOL | lamports |
|---|---|---|
| Pro 30 days (`p30`) | 0.48 | 480000000 |
| Pro 90 days (`p90`) | 1.28 | 1280000000 |
| Pro 365 days (`p365`) | 4 | 4000000000 |
| Featured 24h | 1 | 1000000000 |
| Test price (allow-listed wallets in `TEST_WALLETS` only) | 0.001 | 1000000 |

`site/config.js`: `proApi`, `treasury`, `proPrices: { 30: 0.48, 90: 1.28, 365: 4 }`, `featuredPriceSol: 1`, `paymentsEnabled: false`.
Display only; the server prices every order.

## Database (`supabase/migrations/20261010120000_pro.sql`)
Tables (RLS on, no anon/authenticated access; everything goes through Edge Functions with the service role):
`profiles(wallet)`, `auth_nonces`, `orders`, `subscriptions(wallet, plan, expires_at)`, `telegram_links`, `pro_feed`, `audit_log`.

`orders`: `id uuid, wallet, kind ('pro'|'featured'), plan ('p30'|'p90'|'p365'|'featured'), days, ca, meta jsonb, lamports bigint,
test bool, reference text unique, status ('pending'|'paid'|'expired'), signature text unique, paid_lamports, created_at,
expires_at (+20 min), paid_at, checked_at, fulfilled_at`.

`public.fulfil_order(order, signature, paid)` (service_role only) locks + marks the order paid, idempotently. For `pro` it
also stacks the subscription and sets `fulfilled_at`. For `featured` it only marks paid → returns `{ok, kind:'featured', fulfilled:false}`;
the function layer then calls `fulfilFeatured` and on success `public.mark_order_fulfilled(order)`.

**Featured worker:** add `featured_listings` (+ anything else) in a migration with a LATER timestamp, e.g.
`supabase/migrations/20261010130000_featured.sql`. Don't edit the pro migration.

## Edge Functions (`supabase/functions/*`, base `https://wrlsgqfpcvdjzsueikxw.supabase.co/functions/v1`)
All JSON; CORS for maxigems.fun / www.maxigems.fun; `verify_jwt=false` at the gateway (sessions are our own SIWS JWTs).
Auth header: `Authorization: Bearer <session token from auth/verify>`.

| function | request | response |
|---|---|---|
| `auth` | `{action:'nonce', wallet}` | `{nonce, message}` (sign `message` with solana:signMessage) |
| `auth` | `{action:'verify', message, signature(b58)}` | `{token, wallet, expiresAt}` (24h HS256, claim `wallet`) |
| `account` GET | (optional auth) | `{paymentsEnabled, plans[], featured{sol,hours,lamports}, treasury, signedIn, wallet?, pro{active,plan,expiresAt,daysLeft}?, telegram{linked}?}` |
| `account` POST | `{action:'tg-link'}` / `{action:'tg-invite'}` | `{url}` deep link / single-use Pro group invite |
| **`create-order`** | `{kind:'pro', plan}` or `{kind:'featured', ca}` (auth) | `{orderId, reference, lamports, treasury, expiresAt, kind, plan, sol, test, label}`; 401 signed out, 403 payments disabled, 4xx from the featured hook |
| **`verify-payment`** | `{orderId, signature}` (auth) | 200 `{ok:true, status:'paid', result, account}` · 202 `{retry:true}` not on-chain yet · 422 `{reason, message}` |
| `pro-data` GET | (auth) | 200 `{whaleMoves, watchlist}` · 401 · 402 |
| `ingest` | engine → live Pro data (`x-ingest-secret`) | |
| `telegram` | Bot webhook (`x-telegram-bot-api-secret-token`) | `/start <token>` links Telegram; `callback_query` → featured hook |
| `sweep` | cron every 2 min (`x-sweep-secret`) | pending orders via `getSignaturesForAddress(reference)`, expiries + Telegram kicks, retries unfulfilled paid orders, then `sweepFeatured` |

On-chain checks (`_shared/verify.js`): tx succeeded; fee payer + signer = signed-in wallet; reference key present;
SystemProgram transfers payer → treasury ≥ price; signature never used before (unique index).

## Featured hooks — `supabase/functions/_shared/featured.ts` (featured worker owns it; `pro` ships a stub)
```ts
validateFeaturedOrder(ca: string, d: Deps, wallet?: string): Promise<{ok:true, meta} | {ok:false, status, error, reasons?}>
fulfilFeatured(d: Deps, order: Row, signature: string): Promise<{ok:boolean, result?, error?}>   // idempotent per order.id
handleFeaturedCallback(d: Deps, callbackQuery): Promise<boolean>   // admin "Pull listing" etc.
sweepFeatured(d: Deps): Promise<Record<string, number>>             // lifecycle + 1 sponsored post/day
```
`Deps = {store, env, fetch, now}` (`_shared/app.ts`). `store` is `RestStore` (PostgREST) / `MemoryStore` (tests) from
`_shared/store.ts`; extend both with your listing methods. Reusable: `helius()` (exported from app.ts),
`analyzeReport` + `SAFETY_DEFAULTS` (`_shared/safety-rules.js`, the engine's exact RugCheck rules), `tgCall`, `esc`, `clean` (`_shared/tg.js`),
`FEATURED` (`_shared/plans.js`). Env available: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID` (8995645285),
`TELEGRAM_CHANNEL_ID` (@maxigems_calls), `HELIUS_API_KEY`, `SITE_URL`.

Reference implementation of featured scheduling/caps/admin DM/sponsored post (pre-split) is in commit `7372fee`
(`_shared/featured.js`, the old `featured_listings` SQL in `fulfil_order`, tests) — take what's useful.

## Client — `site/assets/pay.js` (`npm run build:pay`, treasury baked in from `site/config.js`)
Lazy-load it (like tip-wallet.js) or via `/assets/pro.js` → `MGProLoad()` (returns a Promise of `window.MGPay`).
```js
MGPay.session()            // {token, wallet, expiresAt} | null
MGPay.signIn()             // Promise<session>  (wallet picker: Phantom / Solflare / Jupiter, signMessage)
MGPay.signOut()
MGPay.api(path, {method, body})   // fetch a function with the session token
MGPay.account()
MGPay.payOrder({kind:'pro', plan:'p30'|'p90'|'p365'} | {kind:'featured', ca})
  // → Promise<{status:'paid'|'pending', signature, orderId, result, account}>
  // rejects Error{status:'cancelled'|'disabled'|'error', message}
```
`window` event `mg:session` fires on sign-in/out/payment. Modal reuses the tip modal styles (`.tw-*` in styles.css).
The bundle refuses to sign if `create-order` returns a treasury different from the baked one.

## Secrets (Supabase function secrets; set by `scripts/supabase-deploy.sh`)
`PAYMENTS_ENABLED` (false), `TEST_WALLETS`, `TREASURY_WALLET`, `HELIUS_API_KEY`, `SESSION_JWT_SECRET`, `SWEEP_SECRET`,
`INGEST_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_PRO_GROUP_ID` (-1004352042429),
`TELEGRAM_ADMIN_CHAT_ID` (8995645285), `TELEGRAM_CHANNEL_ID`, `SITE_URL`.

## Tests
`npm test` (Node, includes `test/pro-shared.test.js`), `npm run test:functions` (Deno, MemoryStore + fake RPC/Telegram),
`npm run check:sql` (PGlite; `npm i --no-save @electric-sql/pglite` first).

## Telegram webhook
The engine (src/) only calls sendMessage/sendPhoto-style methods and never `getUpdates`, so pointing @Maxigems_bot's webhook at the `telegram` Edge Function is safe. It is the only consumer of updates (`/start <token>` linking). **Setting a webhook disables `getUpdates`** for this bot: any manual/ad-hoc `getUpdates` polling returns 409 until `deleteWebhook`. The webhook is set only by `scripts/supabase-deploy.sh --webhook`, after the user approves.
