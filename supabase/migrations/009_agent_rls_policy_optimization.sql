-- Evaluate auth.uid() once per statement for agent-owned tables.
drop policy if exists "Users manage own agent tool permissions" on public.agent_tool_permissions;
create policy "Users manage own agent tool permissions" on public.agent_tool_permissions
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage own agent approvals" on public.agent_approvals;
create policy "Users manage own agent approvals" on public.agent_approvals
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
