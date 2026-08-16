# EZWin

Responsive Claude-designed EZWin operator UI built with React, Vite and Supabase.

## Local development

```bash
npm ci
npm run dev
```

Browser-safe Supabase variables belong in `.env`:

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLIC_PUBLISHABLE_KEY
```

Never commit `.env`, `.env.supabase-secrets`, the database password, service-role keys or server secrets.

## Checks

```bash
npm test
npm run build
```

## GitHub Pages

The included workflow tests, builds and deploys every push to `main`.

1. Repository **Settings → Secrets and variables → Actions → Variables**
2. Add `VITE_SUPABASE_URL`
3. Add `VITE_SUPABASE_PUBLISHABLE_KEY`
4. Repository **Settings → Pages → Source → GitHub Actions**
5. Push `main`

The publishable key is intended for browser use. Server secrets remain in Supabase.

## Data

- Supabase Auth: generated-ID/PIN accounts and persistent sessions.
- `operator_state`: profile-scoped names, number-entry records, dealer state and history across devices.
- RLS prevents one signed-in profile from reading another profile's operator state.
- The current single-operator build retains the approved dark green/gold visual design.
