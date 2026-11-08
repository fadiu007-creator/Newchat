-- Enforce that every child record belongs to the same owner as its run.
alter table public.agent_runs
  add constraint agent_runs_id_user_id_key unique (id, user_id);

alter table public.agent_tasks
  drop constraint if exists agent_tasks_run_id_fkey;
alter table public.agent_tasks
  add constraint agent_tasks_run_owner_fkey
  foreign key (run_id, user_id)
  references public.agent_runs (id, user_id)
  on delete cascade;

alter table public.agent_steps
  drop constraint if exists agent_steps_run_id_fkey;
alter table public.agent_steps
  add constraint agent_steps_run_owner_fkey
  foreign key (run_id, user_id)
  references public.agent_runs (id, user_id)
  on delete cascade;

alter table public.agent_artifacts
  drop constraint if exists agent_artifacts_run_id_fkey;
alter table public.agent_artifacts
  add constraint agent_artifacts_run_owner_fkey
  foreign key (run_id, user_id)
  references public.agent_runs (id, user_id)
  on delete cascade;

alter table public.agent_events
  drop constraint if exists agent_events_run_id_fkey;
alter table public.agent_events
  add constraint agent_events_run_owner_fkey
  foreign key (run_id, user_id)
  references public.agent_runs (id, user_id)
  on delete cascade;
