# Newchat

A unified AI chat workspace using provider gateways, with OpenRouter and Eden AI integrations.

## Stack
- React + TypeScript + Vite
- Cloudflare Workers API
- Supabase email/password Auth + Postgres with row-level security
- OpenRouter multi-model gateway
- Eden AI v3 model gateway

## Local development
```bash
npm install
cp .env.example .env
npm run dev
# In a second terminal:
npm run dev:worker
```

Vite runs on port 5173 and proxies `/api` requests to Wrangler on port 8787. Provider keys must only be stored as Cloudflare Worker secrets, never in browser variables.

## Supabase setup
1. Use the existing Zikos Supabase project (do not create another project for this app).
2. In Cloudflare Worker build settings, set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as build-time variables (the URL and publishable/anon key are public client configuration, not provider secrets). The frontend reads these at Vite build time; runtime Worker secrets with different names do not populate them.
3. Apply `supabase/migrations/001_conversations.sql` and then `002_add_edenai_provider.sql` only when setting up a fresh database. The Newchat migrations have already been applied to the shared Zikos project.
4. Enable Email authentication in Supabase. Newchat currently uses email/password sign-in; Google OAuth is intentionally disabled.
5. Set Cloudflare Worker secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY` to the same project URL and publishable/anon key so the API can verify signed-in sessions.

## Cloudflare configuration

**Build-time variables** (Cloudflare build settings; required for the frontend sign-in UI):
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

**Worker runtime secrets** (Worker Settings → Variables and Secrets):
- `OPENROUTER_API_KEY`
- `EDENAI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

The Worker serves both the frontend and `/api/*` from `https://newchat.shqiptare.workers.dev`; keep `ALLOWED_ORIGIN` set to that exact origin. No Pages deployment is required.

## Current status
The repository contains the application scaffold, OpenRouter/Eden AI provider routing, Supabase email/password authentication UI, per-user conversation persistence with row-level security, and conversation search/rename/delete/Markdown export. Frontend Supabase environment variables and Cloudflare Worker secrets must be configured by the project owner before hosted authentication and chat requests can work. Google OAuth is not part of the current build.
