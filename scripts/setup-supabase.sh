#!/usr/bin/env bash
set -euo pipefail

PROJECT_REF="${1:-}"
PUBLISHABLE_KEY="${2:-}"
SITE_URL="${3:-http://localhost:5173}"

if [[ -z "$PROJECT_REF" || -z "$PUBLISHABLE_KEY" ]]; then
  echo "Usage: npm run setup:supabase -- PROJECT_REF PUBLISHABLE_KEY [SITE_URL]"
  exit 1
fi

SECRET_FILE=".env.supabase-secrets"
if [[ ! -f "$SECRET_FILE" ]]; then
  umask 077
  printf 'PIN_PEPPER=%s\nAPP_INTERNAL_SECRET=%s\n' \
    "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > "$SECRET_FILE"
fi
set -a
source "$SECRET_FILE"
set +a

npx supabase link --project-ref "$PROJECT_REF"
npx supabase secrets set --project-ref "$PROJECT_REF" \
  "PIN_PEPPER=$PIN_PEPPER" \
  "APP_INTERNAL_SECRET=$APP_INTERNAL_SECRET" \
  "APP_ALLOWED_ORIGINS=$SITE_URL,http://localhost:5173,http://127.0.0.1:5173,http://localhost:5175,http://127.0.0.1:5175"
npx supabase db push --linked

for function_name in \
  login-ezwin-user \
  activate-ezwin-user \
  register-ezwin-user \
  request-password-recovery \
  verify-password-recovery
do
  npx supabase functions deploy "$function_name" --project-ref "$PROJECT_REF"
done

printf 'VITE_SUPABASE_URL=https://%s.supabase.co\nVITE_SUPABASE_PUBLISHABLE_KEY=%s\n' \
  "$PROJECT_REF" "$PUBLISHABLE_KEY" > .env

echo "EZWin Supabase setup complete. Run: npm run dev"
