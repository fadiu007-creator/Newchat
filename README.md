# Newchat

A multi-provider AI chat application and goal-based autonomous agent. Newchat runs on Cloudflare Workers and the existing Zikos Supabase project. It does not require Vercel or Cloudflare Workers Paid features.

## Stack

- React, TypeScript and Vite
- Cloudflare Workers + Cloudflare Workflows
- Supabase Auth and Postgres with row-level security
- OpenRouter and Eden AI model gateways
- GitHub App integration for repository operations
- GitHub Actions hosted runners for isolated code execution

## Local development

```bash
npm install
cp .env.example .env
npm run dev
# In a second terminal:
npm run dev:worker
```

Provider credentials belong only in Worker secrets. Never put provider or service-role keys in Vite variables.

## Existing Supabase project

Use the existing Zikos project. Do not create a second Supabase project for Newchat.

- Project URL: `https://saavqlbwffrwxingbnri.supabase.co`
- Frontend build variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- Worker runtime variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY`
- Worker secret: `SUPABASE_SERVICE_ROLE_KEY`

The existing Zikos database already has the Newchat agent tables, owner-scoped RLS policies, generic approvals, spend ledger and atomic reservation routine. Migrations `014_agent_paid_model_approval_reservation.sql`, `015_agent_chat_spend_without_run_id.sql` and `016_agent_paid_model_hard_budget_cap.sql` add atomic approval consumption, direct-chat spend reservations and a database-enforced $1.00 rolling 24-hour hard cap. They have been applied to the connected Zikos project.

For a fresh database, apply the numbered migrations in order after verifying the current schema and the existing shared-project migrations. Enable Supabase email/password authentication.

## Cloudflare Worker configuration

The Worker and SPA are served from `https://newchat.shqiptare.workers.dev`. The Workflow binding is declared in `wrangler.toml`.

Required runtime secrets:

- `OPENROUTER_API_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` — server-only; never expose it to the browser or a sandbox.
- `SUPABASE_URL` and `SUPABASE_ANON_KEY` — session verification.

Optional provider secret:

- `EDENAI_API_KEY`

The app uses Cloudflare Workflows, which are available on Workers Free. The current Free limits include 3,000 Workflow steps/day, 100,000 executions/day, 100 concurrent instances, 1 GB-month storage, 10 ms CPU per invocation and 50 external subrequests per invocation. The sandbox poller is capped at 20 checks/100 seconds to leave room for database and model calls. Monitor usage in Cloudflare; this is a bounded MVP runner, not an unlimited build farm. Newchat does not bind Cloudflare Containers or require the Workers Paid plan.

## GitHub App setup

The agent uses a GitHub App installation token. The Worker mints short-lived installation tokens using the App private key; it does not store a long-lived installation token.

Create a GitHub App and install it only on repositories you intend Newchat to access. Grant these repository permissions:

- Actions: Read and write (dispatch the sandbox workflow)
- Checks: Read (retrieve independent execution receipts)
- Contents: Read and write (inspect and edit files, create branches)
- Pull requests: Read and write (open and merge pull requests)

Set these Cloudflare Worker secrets:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY` — the complete PEM private key; preserve newlines or use escaped `\n`
- `GITHUB_APP_INSTALLATION_ID`

A fine-grained `GITHUB_APP_TOKEN` secret can be used as a fallback, but it expires and must be rotated manually. Prefer the App credentials above.

The sandbox dispatch repository is configured as `GITHUB_SANDBOX_REPOSITORY` in `wrangler.toml`. In Agent workspace → GitHub tools, enable GitHub access and enter the user's repository allowlist. The installation must also have access to those repositories. Repository reads may run automatically; all repository writes, branch creation, pull requests and merges pause for explicit owner approval.

## Autonomous model routing and fallback

The agent uses explicitly free OpenRouter and Eden AI routes. Eden AI's Gemma 4 31B, Gemma 4 26B A4B and Ternary Bonsai 27B were verified in Newchat's free-model picker and are registered for execution. Models with successful execution history rank ahead of untested models; models with failures and no successes are demoted rather than rewarded for low latency. Each provider attempt runs once inside its durable Workflow step; the agent loop performs fallback, with bounded provider timeouts. Coding tasks dispatch to the isolated GitHub Actions runner and are only marked successful after the matching independent Check Run receipt confirms the command exit code.

## Sandboxed code execution

Coding tasks are dispatched to `.github/workflows/agent-sandbox.yml` on the public Newchat repository. GitHub Actions provides the ephemeral hosted VM; the job then runs untrusted code inside a Docker container with:

- No container network access
- Read-only container root filesystem
- A bounded writable workspace and temporary filesystem
- Non-root UID, dropped Linux capabilities and no-new-privileges
- CPU, memory, PID and wall-clock limits
- No application secrets, GitHub token or Supabase credentials passed into the container

The host preloads the repository-locked Node dependencies and mounts them read-only for offline test execution. The runner supports JavaScript, TypeScript (Node's type stripping) and Python standard-library tasks. The dispatch payload is deliberately bounded (20 files, 32 KB total source, 180-second maximum execution). It is not intended for large builds or package downloads requiring network access.

The workflow publishes a GitHub Check Run with the unique request ID, exit code, stdout/stderr summary and result. The Worker retrieves that Check Run and validates its request ID and conclusion before recording success. A model statement alone is never treated as a successful execution.

## GitHub operations and independent verification

The agent can request repository reads, branch creation, file updates, pull requests, merges and commit verification. Writes are stored as owner-scoped approval records with a hash of the exact proposed operation. Approval is one-use and expires; rejection stops the run. Per-user repository allowlists are enforced in the Workflow, and an optional global allowlist can be configured with `GITHUB_ALLOWED_REPOSITORIES`.

Commit verification retrieves the commit, combined status and Check Runs directly from GitHub. A commit is not considered verified unless the commit exists, the combined status is successful, and all relevant check runs have completed successfully.

## Paid-model approvals and spend limits

Agent execution currently stays on free model routes. In normal chat, free models continue without paid spend. Paid OpenRouter models require an explicit confirmation for each request. Before forwarding a paid request, the Worker:

1. Retrieves current per-token model pricing from OpenRouter.
2. Estimates the request cost using the prompt size and output-token ceiling.
3. Creates a short-lived, owner-scoped approval bound to a SHA-256 hash of the exact provider, model and messages.
4. On approval, atomically consumes that approval and reserves estimated spend in Supabase.
5. Enforces a rolling 24-hour paid-model cap of **$1.00** across the user's Newchat account.
6. Settles the reservation against reported provider cost when usage metadata is returned; otherwise the conservative estimate remains recorded.

Paid Eden AI models are blocked until verifiable per-request pricing and usage are available. A failed or unapproved request is never silently routed to a paid model.

## Independent Cloudflare deployment verification

The optional `.github/workflows/deploy-cloudflare.yml` workflow deploys the Worker and checks the live `/api/health` response against the exact Git commit SHA.

To enable it, set the GitHub repository variable:

- `CLOUDFLARE_DEPLOY_ENABLED=true`

And add GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN` with permission to deploy this Worker
- `CLOUDFLARE_ACCOUNT_ID`

If deployment is not enabled, the workflow is skipped. A green build alone is not reported as proof of a live deployment. The live health endpoint exposes `build_sha` so a verifier can detect stale deployments.

## Verification

Run locally:

```bash
npm install
npm run test:safety
npm run build
npx wrangler deploy --dry-run
```

CI runs the safety tests, frontend TypeScript/Vite build and Worker dry-run. The sandbox, GitHub App, paid approval and deployment paths additionally require the corresponding owner-managed secrets and an installed GitHub App. The health endpoint reports whether those integrations are configured; configuration alone is not proof of successful external execution.
