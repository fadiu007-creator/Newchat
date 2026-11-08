-- Autonomous agent runs, plans, tasks and auditable execution history.
create extension if not exists pgcrypto;

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal text not null check (char_length(goal) between 3 and 12000),
  summary text not null default '',
  status text not null default 'planned'
    check (status in ('planned','queued','running','paused','waiting_for_approval','blocked','completed','failed','cancelled')),
  strategy text not null default 'balanced'
    check (strategy in ('balanced','best_quality','free_first')),
  success_criteria jsonb not null default '[]'::jsonb
    check (jsonb_typeof(success_criteria) = 'array'),
  max_budget_usd numeric(10,2) not null default 0
    check (max_budget_usd >= 0),
  max_runtime_minutes integer not null default 30
    check (max_runtime_minutes between 1 and 1440),
  max_attempts integer not null default 3
    check (max_attempts between 1 and 10),
  total_cost_usd numeric(10,6) not null default 0
    check (total_cost_usd >= 0),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  task_key text not null,
  position integer not null,
  title text not null,
  description text not null default '',
  acceptance_criteria jsonb not null default '[]'::jsonb
    check (jsonb_typeof(acceptance_criteria) = 'array'),
  dependencies text[] not null default '{}',
  status text not null default 'pending'
    check (status in ('pending','ready','running','verifying','completed','blocked','failed','skipped')),
  assigned_provider text,
  assigned_model text,
  attempts integer not null default 0 check (attempts >= 0),
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, task_key),
  unique (run_id, position)
);

create table if not exists public.agent_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  task_id uuid references public.agent_tasks(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  attempt integer not null default 1,
  step_type text not null check (step_type in ('plan','model','tool','verification','repair','system')),
  provider text,
  model text,
  input_summary text not null default '',
  output_summary text not null default '',
  status text not null default 'completed'
    check (status in ('running','completed','failed','skipped')),
  duration_ms integer,
  cost_usd numeric(10,6) not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.agent_artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  task_id uuid references public.agent_tasks(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  mime_type text not null default 'text/plain',
  storage_path text,
  content_text text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.agent_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  task_id uuid references public.agent_tasks(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists agent_runs_user_created_idx on public.agent_runs(user_id, created_at desc);
create index if not exists agent_tasks_run_position_idx on public.agent_tasks(run_id, position);
create index if not exists agent_tasks_user_status_idx on public.agent_tasks(user_id, status);
create index if not exists agent_steps_run_created_idx on public.agent_steps(run_id, created_at);
create index if not exists agent_events_run_created_idx on public.agent_events(run_id, created_at);
create index if not exists agent_artifacts_run_created_idx on public.agent_artifacts(run_id, created_at);

alter table public.agent_runs enable row level security;
alter table public.agent_tasks enable row level security;
alter table public.agent_steps enable row level security;
alter table public.agent_artifacts enable row level security;
alter table public.agent_events enable row level security;

drop policy if exists "Users manage own agent runs" on public.agent_runs;
create policy "Users manage own agent runs" on public.agent_runs
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users manage own agent tasks" on public.agent_tasks;
create policy "Users manage own agent tasks" on public.agent_tasks
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users manage own agent steps" on public.agent_steps;
create policy "Users manage own agent steps" on public.agent_steps
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users manage own agent artifacts" on public.agent_artifacts;
create policy "Users manage own agent artifacts" on public.agent_artifacts
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users manage own agent events" on public.agent_events;
create policy "Users manage own agent events" on public.agent_events
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on public.agent_runs to authenticated;
grant select, insert, update, delete on public.agent_tasks to authenticated;
grant select, insert, update, delete on public.agent_steps to authenticated;
grant select, insert, update, delete on public.agent_artifacts to authenticated;
grant select, insert, update, delete on public.agent_events to authenticated;
