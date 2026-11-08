-- Agent execution control plane: model catalogue, measured metrics, approvals and tool grants.
-- Backward-compatible additions to the existing Newchat agent schema.

alter table public.agent_runs
  add column if not exists idempotency_key text,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists paused_at timestamptz,
  add column if not exists cancel_requested_at timestamptz,
  add column if not exists last_error text,
  add column if not exists execution_started_at timestamptz;

create unique index if not exists agent_runs_user_idempotency_idx
  on public.agent_runs(user_id, idempotency_key)
  where idempotency_key is not null;

alter table public.agent_tasks
  add column if not exists task_type text not null default 'general',
  add column if not exists verification_status text not null default 'not_started'
    check (verification_status in ('not_started','running','passed','failed','needs_review')),
  add column if not exists evidence jsonb not null default '[]'::jsonb
    check (jsonb_typeof(evidence) = 'array'),
  add column if not exists next_retry_at timestamptz;

create table if not exists public.model_registry (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('openrouter','edenai')),
  model_id text not null,
  display_name text not null,
  capabilities text[] not null default '{}',
  context_window integer,
  input_cost_per_million numeric(12,6),
  output_cost_per_million numeric(12,6),
  is_free boolean not null default false,
  enabled boolean not null default true,
  priority integer not null default 100,
  last_verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, model_id)
);

create table if not exists public.model_metrics (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  model_id text not null,
  task_type text not null default 'general',
  sample_count integer not null default 0 check (sample_count >= 0),
  success_count integer not null default 0 check (success_count >= 0),
  failure_count integer not null default 0 check (failure_count >= 0),
  avg_latency_ms integer,
  avg_cost_usd numeric(12,6),
  quality_score numeric(5,4) check (quality_score between 0 and 1),
  last_sample_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(provider, model_id, task_type)
);

create table if not exists public.agent_tool_permissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tool_name text not null,
  enabled boolean not null default false,
  approval_required boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, tool_name)
);

create table if not exists public.agent_approvals (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  task_id uuid,
  user_id uuid not null references auth.users(id) on delete cascade,
  action_type text not null,
  description text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','expired','cancelled')),
  expires_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint agent_approvals_run_owner_fkey
    foreign key (run_id, user_id)
    references public.agent_runs(id, user_id) on delete cascade,
  constraint agent_approvals_task_fkey
    foreign key (task_id) references public.agent_tasks(id) on delete set null
);

create index if not exists agent_approvals_user_status_idx
  on public.agent_approvals(user_id, status, created_at desc);
create index if not exists agent_tool_permissions_user_idx
  on public.agent_tool_permissions(user_id, tool_name);
create index if not exists model_metrics_lookup_idx
  on public.model_metrics(task_type, provider, model_id);

alter table public.model_registry enable row level security;
alter table public.model_metrics enable row level security;
alter table public.agent_tool_permissions enable row level security;
alter table public.agent_approvals enable row level security;

drop policy if exists "Authenticated users can read model registry" on public.model_registry;
create policy "Authenticated users can read model registry" on public.model_registry
  for select to authenticated using (true);

drop policy if exists "Authenticated users can read model metrics" on public.model_metrics;
create policy "Authenticated users can read model metrics" on public.model_metrics
  for select to authenticated using (true);

drop policy if exists "Users manage own agent tool permissions" on public.agent_tool_permissions;
create policy "Users manage own agent tool permissions" on public.agent_tool_permissions
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users manage own agent approvals" on public.agent_approvals;
create policy "Users manage own agent approvals" on public.agent_approvals
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Explicit grants are required for newly-created public tables in current Supabase projects.
grant select on public.model_registry to authenticated;
grant select on public.model_metrics to authenticated;
grant select, insert, update, delete on public.agent_tool_permissions to authenticated;
grant select, insert, update, delete on public.agent_approvals to authenticated;

-- The free catalogue contains only models explicitly marked free by the provider's model ID.
insert into public.model_registry(provider, model_id, display_name, capabilities, is_free, priority, metadata)
values
  ('openrouter','openrouter/free','OpenRouter Free Router',array['general','analysis','coding','writing'],true,10,'{"routing":"provider-managed-free"}'::jsonb),
  ('openrouter','nvidia/nemotron-3-ultra-550b-a55b:free','Nemotron 3 Ultra',array['general','analysis','coding'],true,20,'{}'::jsonb),
  ('openrouter','nvidia/nemotron-3.5-super-vl:free','Nemotron 3.5 Super VL',array['general','analysis','vision'],true,30,'{}'::jsonb),
  ('openrouter','nvidia/nemotron-3.5-lightning:free','Nemotron 3.5 Lightning',array['general','analysis','coding'],true,40,'{}'::jsonb),
  ('openrouter','cohere/north-mini-code:free','North Mini Code',array['coding'],true,30,'{}'::jsonb),
  ('openrouter','dots-studio/dots-3-note-preview:free','Dots 3 Note Preview',array['general','writing'],true,50,'{}'::jsonb),
  ('openrouter','recursive/flint-v1.0:free','Flint',array['general','analysis'],true,50,'{}'::jsonb),
  ('openrouter','liquid/lfm-3-1.7b:free','LFM 3 1.7B',array['general'],true,80,'{}'::jsonb)
on conflict(provider, model_id) do update
set display_name=excluded.display_name, capabilities=excluded.capabilities,
    is_free=excluded.is_free, enabled=true, updated_at=now();
