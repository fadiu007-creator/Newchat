# Newchat

A unified AI chat workspace for OpenRouter and OpenAI, with a provider adapter architecture for future gateways such as Eden AI and LiteLLM.

## Stack
- React + TypeScript + Vite
- Cloudflare Workers API
- Supabase Auth and Postgres (planned integration)
- OpenRouter for multi-model access
- Direct OpenAI integration for OpenAI-specific capabilities

## Local development
```bash
npm install
cp .env.example .env
npm run dev
# In a second terminal, run the API worker:
npm run dev:worker
```

The Vite UI runs on port 5173 and proxies /api requests to the Wrangler Worker on port 8787. Provider requests are made through the Worker API; never put provider API keys in browser variables.

Deploy with `npm run deploy` after setting Worker secrets.

## Worker secrets
Set these with Wrangler or the Cloudflare dashboard:
- `OPENROUTER_API_KEY` (optional until configured)
- `OPENAI_API_KEY` (optional until configured)
- `ALLOWED_ORIGIN` (your deployed frontend origin)

## Current status
Initial application scaffold. Authentication, durable conversation persistence, billing, and production provider configuration are not yet enabled. Do not treat the demo/local conversation state as secure multi-user storage.
