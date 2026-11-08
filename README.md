# Newchat

A unified AI chat workspace for OpenRouter and OpenAI, designed to support additional gateways such as Eden AI and LiteLLM.

## Stack
- React + TypeScript + Vite
- Cloudflare Workers API
- Supabase email/password Auth + Postgres with row-level security
- OpenRouter multi-model gateway
- Direct OpenAI API integration
- Eden AI v3 OpenAI-compatible model gateway

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
2. Set the project URL in `VITE_SUPABASE_URL` and the publishable/anon key in `VITE_SUPABASE_ANON_KEY` for the frontend build.
3. Apply `supabase/migrations/001_conversations.sql` and then `002_add_edenai_provider.sql` only when setting up a fresh database. The Newchat migrations have already been applied to the shared Zikos project.
4. Enable Email authentication in Supabase. Newchat currently uses email/password sign-in; Google OAuth is intentionally disabled.
5. Set Cloudflare Worker secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY` to the same project URL and publishable/anon key so the API can verify signed-in sessions.

## Cloudflare Worker secrets
- `OPENROUTER_API_KEY`
- `OPENAI_API_KEY`
- `EDENAI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

Set `ALLOWED_ORIGIN` in `wrangler.toml` to the exact production frontend origin.

## Current status
The repository contains the application scaffold, OpenRouter/OpenAI/Eden AI provider routing, Supabase email/password authentication UI, per-user conversation persistence with row-level security, and conversation search/rename/delete/Markdown export. Frontend Supabase environment variables and Cloudflare Worker secrets must be configured by the project owner before hosted authentication and chat requests can work. Google OAuth is not part of the current build.
