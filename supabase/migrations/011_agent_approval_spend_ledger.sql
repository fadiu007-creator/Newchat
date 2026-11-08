-- Durable approval decisions and auditable model/tool spend accounting.
alter table public.agent_approvals
  add column if not exists action_hash text,
  add column if not exists requested_by text not null default 'agent',
  add column if not exists decision_note text,
  add column if not exists consumed_at timestamptz;

create index if not exists agent_approvals_run_status_idx
  on public.agent_approvals(run_id, status, created_at desc);

create table if not exists public.agent_run_spend (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid,
  provider text not null check (provider in ('openrouter','edenai','sandbox','github')),
  model_id text,
  usage_kind text not null check (usage_kind in ('model','sandbox','tool')),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cost_usd numeric(14,8) not null check (cost_usd >= 0),
  external_receipt_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint agent_run_spend_run_owner_fkey
    foreign key (run_id, user_id)
    references public.agent_runs(id, user_id) on delete cascade,
  constraint agent_run_spend_task_fkey
    foreign key (task_id) references public.agent_tasks(id) on delete set null
);

create index if not exists agent_run_spend_run_idx
  on public.agent_run_spend(run_id, user_id, created_at);
create index if not exists agent_run_spend_task_idx
  on public.agent_run_spend(task_id);

alter table public.agent_run_spend enable row level security;
drop policy if exists "Users read own agent spend" on public.agent_run_spend;
create policy "Users read own agent spend" on public.agent_run_spend
  for select to authenticated using (auth.uid() = user_id);
grant select on public.agent_run_spend to authenticated;
