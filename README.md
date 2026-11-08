# Newchat

A unified AI chat workspace for OpenRouter and OpenAI, designed to support additional gateways such as Eden AI and LiteLLM.

## Stack
- React + TypeScript + Vite
- Cloudflare Workers API
- Supabase Auth + Postgres with row-level security
- OpenRouter multi-model gateway
- Direct OpenAI API integration

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
1. Create a Supabase project.
2. Add the project URL to `VITE_SUPABASE_URL` and its publishable/anon key to `VITE_SUPABASE_ANON_KEY`.
3. Run `supabase/migrations/001_conversations.sql` and then `002_add_edenai_provider.sql` in the Supabase SQL editor.
4. In Supabase Authentication, enable Email and Google providers. For Google, configure the OAuth client and Supabase callback URL in Google Cloud; add your app URL to Supabase's allowed redirect URLs.
5. Set Worker secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY` to the same project values so the API can verify signed-in sessions.

## Cloudflare Worker secrets
- `OPENROUTER_API_KEY`
- `OPENAI_API_KEY`\n- `EDENAI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

Set `ALLOWED_ORIGIN` in `wrangler.toml` to the exact production frontend origin.

## Current status
The repository contains the application scaffold, OpenRouter/OpenAI/Eden AI provider routing, Supabase email/Google authentication UI, per-user conversation persistence with row-level security, and conversation search/rename/delete/Markdown export. Supabase credentials, Google OAuth configuration, Cloudflare secrets, and production deployment must be configured by the project owner before hosted authentication and chat requests can work.
