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
- `SUPABASE_SERVICE_ROLE_KEY` — required only for the server-side Cloudflare Workflow executor. Never expose this key as a Vite/build variable or in browser code.

The `newchat-agent` Cloudflare Workflow binding and `AgentWorkflow` class are declared in `wrangler.toml` and `worker/agent-workflow.ts`. The Agent workspace checks `/api/health` and disables Start when the deployed Worker does not have both the Workflow binding and service-role secret.
- `SUPABASE_SERVICE_ROLE_KEY` (server-only; required for durable agent execution)

The Worker serves both the frontend and `/api/*` from `https://newchat.shqiptare.workers.dev`; keep `ALLOWED_ORIGIN` set to that exact origin. No Pages deployment is required.

## Current status
The repository contains the application scaffold, OpenRouter/Eden AI provider routing, Supabase email/password authentication UI, per-user conversation persistence with row-level security, and conversation search/rename/delete/Markdown export.

The Agent workspace includes durable Cloudflare Workflow orchestration, bounded task attempts, free-model registry refresh from OpenRouter, per-task model routing based on measured task metrics, task outputs, artifact records, event history, and pause/resume/cancel controls. Execution currently generates deliverables through AI models; it does **not** yet have connected browser automation, general web search inside the deployed Worker, sandboxed code execution, file-system tools, GitHub repository actions, or production deployment tools. It must not claim those actions were performed. Only explicitly free OpenRouter models are eligible; paid-model escalation and real paid-cost accounting are not enabled. The configured budget is stored with the run but is not a paid-spend authorization mechanism.

Frontend Supabase build variables and Worker secrets must be configured by the project owner before hosted authentication and execution work. Google OAuth is not part of the current build.

## Autonomous agent execution

The Agent workspace creates a dependency-aware plan and can start it as a durable Cloudflare Workflow. Execution state, task attempts, model metrics, events and text artifacts are persisted in the existing Zikos Supabase project.

Before enabling execution, add `SUPABASE_SERVICE_ROLE_KEY` as a **Worker secret** in Cloudflare (Settings → Variables and Secrets). Do not add it as a Vite variable or commit it to the repository. The execution API deliberately returns a configuration error until this secret is present. The `newchat-agent` Workflow binding is declared in `wrangler.toml`.

The current runtime routes tasks through the explicitly free OpenRouter model registry and records criterion evidence and model metrics. Its verification is model-assisted content review, not an independent test runner. Browser automation, arbitrary code execution, GitHub write operations, production deployment, paid-model escalation/approval and complete tool-permission enforcement are not yet connected. The runtime must not be treated as having performed those external actions.
