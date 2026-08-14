# EZWin V4

EZWin is a mobile-first, anonymous-account lottery management and community application. The React/Vite frontend is static-hosting compatible; authentication, authorization, durable data, realtime updates, auditing, and sensitive operations live in Supabase.

## What is included

- Generated `@pyXXXXXX` accounts with case-insensitive login, single-use expiring activation codes, and 4-digit PINs transformed server-side into strong Auth passwords with an HMAC pepper.
- User, Staff, and Admin navigation plus matching RLS and Edge Function authorization.
- Admin/Staff number entry, legacy reverse formats, closed-number checks, dealer confirmation, admin-only atomic approval, and audit history.
- User-visible live batches/history, result reveal, exact/Twd/repeated-digit/Korea-miss rules, safe result sharing, Community reactions, Dream100, avatars, profiles, and daily entertainment number.
- GitHub Pages workflow using `HashRouter`, so route refreshes work on static hosting.

No application data is stored in browser storage. Supabase Auth may persist its standard session token; PINs, activation codes, pepper, service-role key, and internal Auth identifiers never enter frontend code.

## Local setup

Requirements: Node.js 22+, npm, Supabase CLI, and a Supabase project.

```bash
cp .env.example .env
```

Set only browser-safe values in `.env`:

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLIC_PUBLISHABLE_KEY
```

Then run:

```bash
npm ci
npm run dev
npm test
npm run build
```

## Supabase deployment

Replace `YOUR_PROJECT_REF` and the example origins before running:

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
npx supabase secrets set PIN_PEPPER="$(openssl rand -base64 48)"
npx supabase secrets set APP_INTERNAL_SECRET="$(openssl rand -base64 48)"
npx supabase secrets set APP_ALLOWED_ORIGINS="http://localhost:5173,https://YOUR_GITHUB_USER.github.io"
```

Deploy functions:

```bash
npx supabase functions deploy bootstrap-admin
npx supabase functions deploy create-ezwin-user
npx supabase functions deploy activate-ezwin-user --no-verify-jwt
npx supabase functions deploy login-ezwin-user --no-verify-jwt
npx supabase functions deploy change-pin
npx supabase functions deploy create-lottery-batch
npx supabase functions deploy update-lottery-batch
npx supabase functions deploy submit-to-dealer
npx supabase functions deploy approve-lottery-batch
npx supabase functions deploy reject-lottery-batch
npx supabase functions deploy publish-result
npx supabase functions deploy manage-closed-number
npx supabase functions deploy manage-dream100
npx supabase functions deploy manage-lottery-week
npx supabase functions deploy manage-user
```

Only activation, login, and the one-time bootstrap endpoint disable platform JWT verification. They perform their own method, body, CORS, validation, generic-error, and abuse checks.

### Create the first Admin

Run this exactly once. Use the same `APP_INTERNAL_SECRET` value you set above, and do not save it in shell history on shared machines:

```bash
curl -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/bootstrap-admin" \
  -H "Content-Type: application/json" \
  -H "x-ezwin-bootstrap-secret: YOUR_APP_INTERNAL_SECRET" \
  -d '{"nickname":"EZWin Admin"}'
```

The response displays the Generated ID and activation code once. Activate it from the app and choose a non-obvious 4-digit PIN. The endpoint permanently refuses further bootstrap requests once an Admin exists. You may then delete or undeploy it:

```bash
npx supabase functions delete bootstrap-admin --project-ref YOUR_PROJECT_REF
```

## GitHub Pages

In the GitHub repository, set these **Actions variables** (not secrets are required for public browser credentials):

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Under **Settings → Pages**, select **GitHub Actions** as the source. Push to `main`:

```bash
git add .
git commit -m "Build EZWin V4"
git push origin main
```

The workflow runs tests and a production build before deployment. Server-only secrets stay in Supabase and are never used by GitHub Actions.

## Security notes

- `PIN_PEPPER` and `APP_INTERNAL_SECRET` are required Edge Function secrets. Never prefix them with `VITE_`.
- Community stores only nickname/avatar snapshots and a server-masked Generated ID. The complete ID is absent from Community responses.
- Direct browser mutations of batches, entries, results, activation records, security events, and audits are revoked.
- Login uses account and IP hash rate limits: 5 account failures or 20 IP failures per 15 minutes. Errors never confirm account existence.
- Approval locks the batch in PostgreSQL, recalculates valid totals, prevents double approval, records audit history, and creates safe Community activity in one transaction.
- Staff cannot change roles, approve batches, or operate on Admin accounts. Admin role changes are limited to `staff` and `user` targets.
- Operational history is deactivated/cancelled rather than hard-deleted.

## Migration report

- Database: profiles, server-only Auth identities/activation records, nickname history, weeks, member sequences, batches, entries, closed numbers, results, Community activity/reactions, Dream100, login security events, and audit logs.
- PostgreSQL functions: masking/role helpers, safe profile updates, throttled reactions, atomic save/dealer/approve/reject/result operations.
- Edge Functions: account creation/activation/login/PIN change and complete lottery/admin management.
- Frontend routes: `#/community`, `#/result`, `#/profile`, `#/dream100`, Staff/Admin `#/entry`, and Admin-only `#/admin`.
- Hosting: Vite relative asset base, hash routing, and GitHub Pages Actions deployment.

For an existing production database, review `supabase/migrations/20260815_ezwin_v4.sql` in a staging branch first. It is additive and does not drop existing tables; map any legacy users to Auth UUIDs and the optional `profiles.legacy_id` before enabling the new workflow.
