-- Transactional integration checks for atomic reservations and idempotent settlement.
-- Run only against a disposable local/test database: psql "$DATABASE_URL" -f supabase/tests/ai_budget.sql
-- All setting changes and fixture rows are rolled back at the end.
begin;
-- Exercise service-only budget RPCs with an explicit service-role claim.
set local request.jwt.claim.role = 'service_role';

do $$
declare
  v_first uuid := gen_random_uuid();
  v_second uuid := gen_random_uuid();
  v_third uuid := gen_random_uuid();
  v_limit numeric;
  v_spend numeric;
  v_count integer;
  v_rejected boolean := false;
  v_result jsonb;
begin
  insert into public.application_settings(key, value)
  values ('app_mode', 'approval'), ('ai_paid_calls_enabled', 'true'), ('ai_monthly_limit_usd', '1000')
  on conflict (key) do update set value = excluded.value;

  v_spend := public.month_spend_usd();
  v_limit := greatest(1000, v_spend + 10);
  update public.application_settings set value = v_limit::text where key = 'ai_monthly_limit_usd';

  perform public.reserve_ai_budget(v_first, 0.001);
  v_result := public.settle_ai_budget(v_first, 0.001, jsonb_build_object(
    'communityId', 'stories', 'type', 'text', 'provider', 'mock', 'model', 'mock-model',
    'prompt', 'mock only', 'result', 'mock output', 'costEstimated', true, 'status', 'done'
  ));
  if v_result ->> 'status' <> 'settled' then
    raise exception 'Первое списание не завершилось атомарно';
  end if;

  -- Replaying settlement for a lost RPC response must not create a second cost row.
  perform public.settle_ai_budget(v_first, 0.001, jsonb_build_object(
    'communityId', 'stories', 'type', 'text', 'provider', 'mock', 'model', 'mock-model',
    'prompt', 'retry', 'result', 'duplicate must be ignored', 'status', 'done'
  ));
  select count(*) into v_count from public.ai_generations where budget_reservation_id = v_first;
  if v_count <> 1 then raise exception 'Повтор settlement создал % записей вместо одной', v_count; end if;

  -- A failed provider result is still settled at a conservative attempted cost.
  perform public.reserve_ai_budget(v_second, 0.2);
  perform public.settle_ai_budget(v_second, 0.2, jsonb_build_object(
    'communityId', 'stories', 'type', 'text', 'provider', 'mock', 'model', 'mock-model',
    'prompt', 'mock failure', 'result', '', 'costEstimated', true, 'status', 'error', 'error', 'mock 503'
  ));

  -- Reserve enough to leave less than another equal request; the second must fail.
  v_spend := public.month_spend_usd();
  update public.application_settings set value = (v_spend + 0.5)::text where key = 'ai_monthly_limit_usd';
  perform public.reserve_ai_budget(v_third, 0.3);
  begin
    perform public.reserve_ai_budget(gen_random_uuid(), 0.3);
  exception when check_violation then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'AI-бюджет разрешил суммарные резервы сверх лимита'; end if;
  perform public.release_ai_budget(v_third, 'SQL safety test rollback fixture');

  -- Dry-run is a database-level deny, independent of the Edge Function branch.
  update public.application_settings set value = 'test' where key = 'app_mode';
  v_rejected := false;
  begin
    perform public.reserve_ai_budget(gen_random_uuid(), 0.01);
  exception when insufficient_privilege then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'Платный резерв разрешён в dry-run'; end if;
end $$;

rollback;

-- Emit a result after rollback for CLI/Management API clients.
select 'ai_budget: PASS (transaction rolled back)' as result;
