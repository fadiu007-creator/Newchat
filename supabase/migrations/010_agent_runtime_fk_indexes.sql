-- Index the agent runtime's task/run foreign keys for predictable lookup and delete performance.
create index if not exists agent_approvals_task_run_owner_idx
  on public.agent_approvals(task_id, run_id, user_id);
create index if not exists agent_artifacts_task_id_idx
  on public.agent_artifacts(task_id);
create index if not exists agent_events_task_id_idx
  on public.agent_events(task_id);
create index if not exists agent_steps_task_id_idx
  on public.agent_steps(task_id);
create index if not exists agent_tasks_run_user_idx
  on public.agent_tasks(run_id, user_id);
