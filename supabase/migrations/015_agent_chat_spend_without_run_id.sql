-- Direct chat model usage is not attached to an autonomous agent run.
alter table public.agent_run_spend
  alter column run_id drop not null;

comment on column public.agent_run_spend.run_id is
  'Nullable for direct chat model usage that is not attached to an autonomous agent run.';
