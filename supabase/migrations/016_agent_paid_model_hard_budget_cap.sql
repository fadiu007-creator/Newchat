-- Keep the database-side paid-model spend limit hard-capped at USD 1.00 per rolling 24 hours.
create or replace function public.reserve_paid_model_call(
  p_user_id uuid,
  p_approval_id uuid,
  p_action_hash text,
  p_estimated_cost numeric,
  p_daily_budget numeric,
  p_model_id text
) returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_spent numeric;
  v_reservation_id uuid;
begin
  if p_user_id is null or p_approval_id is null
     or p_action_hash is null or char_length(p_action_hash) <> 64
     or p_estimated_cost is null or p_estimated_cost <= 0
     or p_daily_budget is null or p_daily_budget <= 0 or p_daily_budget > 1.00
     or p_model_id is null or char_length(p_model_id) > 160 then
    raise exception 'Invalid paid-model reservation input; the hard rolling 24-hour cap is $1.00'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  perform 1
    from public.agent_approvals
   where id = p_approval_id
     and user_id = p_user_id
     and action_type = 'paid_model'
     and action_hash = p_action_hash
     and status = 'approved'
     and consumed_at is null
     and (expires_at is null or expires_at > now())
   for update;

  if not found then
    raise exception 'Paid-model approval is missing, expired, already used, or does not match this request'
      using errcode = '42501';
  end if;

  select coalesce(sum(cost_usd), 0)
    into v_spent
    from public.agent_run_spend
   where user_id = p_user_id
     and created_at >= now() - interval '24 hours';

  if v_spent + p_estimated_cost > p_daily_budget then
    raise exception 'Paid-model daily budget exceeded: spent %, requested %, budget %',
      v_spent, p_estimated_cost, p_daily_budget using errcode = 'P0001';
  end if;

  insert into public.agent_run_spend (
    run_id, user_id, provider, model_id, usage_kind, cost_usd, metadata
  ) values (
    null, p_user_id, 'openrouter', p_model_id, 'model', p_estimated_cost,
    jsonb_build_object('reserved', true, 'approval_id', p_approval_id)
  ) returning id into v_reservation_id;

  update public.agent_approvals
     set consumed_at = now()
   where id = p_approval_id and user_id = p_user_id and consumed_at is null;

  if not found then
    raise exception 'Paid-model approval was consumed concurrently' using errcode = '40001';
  end if;

  return v_reservation_id;
end;
$$;

revoke all on function public.reserve_paid_model_call(uuid, uuid, text, numeric, numeric, text) from public, anon, authenticated;
grant execute on function public.reserve_paid_model_call(uuid, uuid, text, numeric, numeric, text) to service_role;
