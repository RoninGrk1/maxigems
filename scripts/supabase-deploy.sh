#!/usr/bin/env bash
# One-command deploy of the MaxiGems Pro backend to Supabase project wrlsgqfpcvdjzsueikxw.
#   SUPABASE_ACCESS_TOKEN=<personal access token of the account that OWNS the maxigems project> \
#     scripts/supabase-deploy.sh [--webhook]
# Needs on the box: SUPABASE_ACCESS_TOKEN (PAT), HELIUS_API_KEY, TELEGRAM_BOT_TOKEN, gh (authed). Never prints secrets.
# Payments stay DISABLED (PAYMENTS_ENABLED=false) — flip it later with:
#   npx supabase secrets set --project-ref wrlsgqfpcvdjzsueikxw PAYMENTS_ENABLED=true   (+ paymentsEnabled:true in site/config.js)
# --webhook also points @Maxigems_bot's webhook at the telegram function (needed for "Link Telegram"; stops getUpdates).
set -euo pipefail
REF=wrlsgqfpcvdjzsueikxw
API=https://api.supabase.com/v1/projects/$REF
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECRETS_FILE="${MAXIGEMS_SECRETS_FILE:-$HOME/.maxigems-pro-secrets}"   # generated once, chmod 600, reused on re-deploys
: "${SUPABASE_ACCESS_TOKEN:?set SUPABASE_ACCESS_TOKEN (personal access token with access to $REF)}"
: "${HELIUS_API_KEY:?}" ; : "${TELEGRAM_BOT_TOKEN:?}"

code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" "$API")
[ "$code" = 200 ] || { echo "token cannot access project $REF (HTTP $code)"; exit 1; }

sql() { # run SQL through the Management API (no DB password needed)
  python3 -c 'import json,sys; print(json.dumps({"query": sys.stdin.read()}))' | \
    curl -sf -X POST "$API/database/query" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H 'content-type: application/json' --data-binary @- >/dev/null
}

# 1) secrets (generated once)
umask 077
if [ ! -f "$SECRETS_FILE" ]; then
  { for k in SESSION_JWT_SECRET SWEEP_SECRET INGEST_SECRET TELEGRAM_WEBHOOK_SECRET; do echo "$k=$(openssl rand -hex 32)"; done; } > "$SECRETS_FILE"
fi
set -a; . "$SECRETS_FILE"; set +a

# 2) migrations (idempotent), in order
for f in "$ROOT"/supabase/migrations/*.sql; do
  case "$f" in *_sweep_cron.sql) continue;; esac
  echo "migrate: $(basename "$f")"; sql < "$f"
done
# vault secret for the cron → sweep call, then the cron migration
printf "do \$\$ begin if exists (select 1 from vault.secrets where name='maxigems_sweep_secret') then perform vault.update_secret((select id from vault.secrets where name='maxigems_sweep_secret'), '%s'); else perform vault.create_secret('%s', 'maxigems_sweep_secret'); end if; end \$\$;" "$SWEEP_SECRET" "$SWEEP_SECRET" | sql
for f in "$ROOT"/supabase/migrations/*_sweep_cron.sql; do echo "migrate: $(basename "$f")"; sql < "$f"; done

# 3) function secrets (PAYMENTS stay off)
cd "$ROOT"
npx -y supabase@latest secrets set --project-ref "$REF" \
  PAYMENTS_ENABLED=false TEST_WALLETS="${TEST_WALLETS:-}" TREASURY_WALLET=9dw32avaHbCsySNJNrwreV5onRTUubMpq88tp5XMwLMX \
  HELIUS_API_KEY="$HELIUS_API_KEY" TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" TELEGRAM_BOT_USERNAME=Maxigems_bot \
  TELEGRAM_PRO_GROUP_ID=-1004352042429 TELEGRAM_ADMIN_CHAT_ID=8995645285 TELEGRAM_CHANNEL_ID=@maxigems_calls \
  SESSION_JWT_SECRET="$SESSION_JWT_SECRET" SWEEP_SECRET="$SWEEP_SECRET" INGEST_SECRET="$INGEST_SECRET" \
  TELEGRAM_WEBHOOK_SECRET="$TELEGRAM_WEBHOOK_SECRET" SITE_URL=https://maxigems.fun/ \
  ALLOWED_ORIGINS=https://maxigems.fun,https://www.maxigems.fun SIWS_DOMAINS=maxigems.fun,www.maxigems.fun >/dev/null

# 4) functions (bundled by the API, no Docker)
for fn in auth account create-order verify-payment pro-data ingest telegram sweep; do
  echo "deploy: $fn"; npx -y supabase@latest functions deploy "$fn" --project-ref "$REF" --use-api --no-verify-jwt >/dev/null
done

# 5) engine → Supabase live Pro data (GitHub Actions)
printf '%s' "$INGEST_SECRET" | gh secret set PRO_INGEST_SECRET -R RoninGrk1/maxigems
gh variable set PRO_INGEST_URL -R RoninGrk1/maxigems -b "https://$REF.supabase.co/functions/v1/ingest"

# 6) optional: Telegram webhook (Link Telegram + admin buttons)
if [ "${1:-}" = "--webhook" ]; then
  curl -sf "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" -H 'content-type: application/json' \
    -d "{\"url\":\"https://$REF.supabase.co/functions/v1/telegram\",\"secret_token\":\"$TELEGRAM_WEBHOOK_SECRET\",\"allowed_updates\":[\"message\",\"callback_query\"],\"drop_pending_updates\":false}" >/dev/null
  echo "telegram webhook set"
fi
code=$(curl -s -o /dev/null -w '%{http_code}' "https://$REF.supabase.co/functions/v1/account")
echo "done. GET /account → HTTP $code (expect 200; payments disabled)"
