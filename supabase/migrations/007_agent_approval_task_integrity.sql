-- Keep approval rows bound to a task in the same run and owned by the same user.
alter table public.agent_tasks
  add constraint agent_tasks_id_run_user_key unique (id, run_id, user_id);

alter table public.agent_approvals
  drop constraint if exists agent_approvals_task_fkey;

alter table public.agent_approvals
  add constraint agent_approvals_task_run_owner_fkey
  foreign key (task_id, run_id, user_id)
  references public.agent_tasks (id, run_id, user_id)
  on delete cascade;
