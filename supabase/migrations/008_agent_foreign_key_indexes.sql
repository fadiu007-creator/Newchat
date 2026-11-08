-- Cover Newchat agent foreign keys to avoid sequential scans during deletes and joins.
create index if not exists agent_tasks_run_owner_idx
  on public.agent_tasks(run_id, user_id);
create index if not exists agent_tasks_user_idx
  on public.agent_tasks(user_id);
create index if not exists agent_steps_run_owner_idx
  on public.agent_steps(run_id, user_id);
create index if not exists agent_steps_task_idx
  on public.agent_steps(task_id);
create index if not exists agent_steps_user_idx
  on public.agent_steps(user_id);
create index if not exists agent_artifacts_run_owner_idx
  on public.agent_artifacts(run_id, user_id);
create index if not exists agent_artifacts_task_idx
  on public.agent_artifacts(task_id);
create index if not exists agent_artifacts_user_idx
  on public.agent_artifacts(user_id);
create index if not exists agent_events_run_owner_idx
  on public.agent_events(run_id, user_id);
create index if not exists agent_events_task_idx
  on public.agent_events(task_id);
create index if not exists agent_events_user_idx
  on public.agent_events(user_id);
create index if not exists agent_approvals_run_owner_idx
  on public.agent_approvals(run_id, user_id);
create index if not exists agent_approvals_task_run_owner_idx
  on public.agent_approvals(task_id, run_id, user_id);
create index if not exists agent_approvals_user_idx
  on public.agent_approvals(user_id);
