-- Atomic AI spend reservations for every paid request.
-- Apply after 20261014120800_owner_bootstrap_safety.sql. Paid calls remain off by default.

begin;

create table if not exists app.ai_budget_periods (
  month_start date primary key check (extract(day from month_start) = 1),
  reserved_usd numeric(14,6) not null default 0 check (reserved_usd >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists app.ai_budget_reservations (
  id uuid primary key,
  month_start date not null references app.ai_budget_periods(month_start),
  reserved_usd numeric(14,6) not null check (reserved_usd > 0),
  actual_usd numeric(14,6) not null default 0 check (actual_usd >= 0),
  status text not null check (status in ('reserved','settled','released')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_note text
);

revoke all on app.ai_budget_periods, app.ai_budget_reservations from public, anon, authenticated, service_role;

grant usage on schema app to service_role;

alter table public.ai_generations
  add column if not exists budget_reservation_id uuid references app.ai_budget_reservations(id);
alter table public.ai_generations
  alter column cost_usd type numeric(12,6) using cost_usd::numeric(12,6);
create unique index if not exists idx_ai_generations_budget_reservation
  on public.ai_generations(budget_reservation_id)
  where budget_reservation_id is not null;

create or replace function public.month_spend_usd()
returns numeric
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select coalesce(sum(cost_usd), 0)::numeric(12,6)
    from public.ai_generations
   where created_at >= (date_trunc('month', timezone('UTC', now())) at time zone 'UTC')
     and created_at < ((date_trunc('month', timezone('UTC', now())) + interval '1 month') at time zone 'UTC');
$$;

create or replace function public.reserve_ai_budget(p_reservation_id uuid, p_estimate_usd numeric)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_month_start date := date_trunc('month', timezone('UTC', now()))::date;
  v_limit numeric;
  v_spent numeric;
  v_reserved numeric;
  v_existing app.ai_budget_reservations;
begin
  if p_reservation_id is null
     or p_estimate_usd is null
     or p_estimate_usd::text in ('NaN','Infinity','-Infinity')
     or p_estimate_usd <= 0
     or p_estimate_usd > 10000 then
    raise exception 'Некорректная оценка AI-расхода; платный вызов заблокирован' using errcode = '22023';
  end if;
  if app.get_setting('app_mode', 'test') <> 'approval'
     or not app.get_bool_setting('ai_paid_calls_enabled', false) then
    raise exception 'Платные AI-вызовы заблокированы в dry-run или без явного серверного разрешения' using errcode = '42501';
  end if;

  insert into app.ai_budget_periods (month_start, reserved_usd)
  values (v_month_start, 0)
  on conflict (month_start) do nothing;

  -- Every reservation, settlement, and release for a UTC month takes this lock.
  -- Concurrent Edge workers therefore cannot all pass on the same stale spend total.
  select reserved_usd into v_reserved
    from app.ai_budget_periods
   where month_start = v_month_start
   for update;

  select * into v_existing
    from app.ai_budget_reservations
   where id = p_reservation_id;
  if found then
    if v_existing.month_start = v_month_start
       and v_existing.status = 'reserved'
       and v_existing.reserved_usd = p_estimate_usd then
      return jsonb_build_object('reservationId', v_existing.id, 'status', v_existing.status,
                                'reservedUsd', v_existing.reserved_usd, 'replayed', true);
    end if;
    raise exception 'Идентификатор AI-резерва уже использован' using errcode = '23505';
  end if;

  begin
    v_limit := coalesce(nullif(app.get_setting('ai_monthly_limit_usd', '20'), '')::numeric, 20);
  exception when others then
    raise exception 'Настройки месячного AI-бюджета повреждены; платный вызов заблокирован' using errcode = '22023';
  end;
  if v_limit::text in ('NaN','Infinity','-Infinity') or v_limit <= 0 then
    raise exception 'Платные AI-вызовы заблокированы: задайте положительный месячный лимит' using errcode = '23514';
  end if;

  v_spent := public.month_spend_usd();
  if v_spent + v_reserved + p_estimate_usd >= v_limit then
    raise exception 'Недостаточно свободного AI-бюджета: потрачено %, зарезервировано %, оценка %, лимит %',
      v_spent, v_reserved, p_estimate_usd, v_limit using errcode = '23514';
  end if;

  insert into app.ai_budget_reservations (id, month_start, reserved_usd, status)
  values (p_reservation_id, v_month_start, p_estimate_usd, 'reserved');
  update app.ai_budget_periods
     set reserved_usd = reserved_usd + p_estimate_usd,
         updated_at = now()
   where month_start = v_month_start;

  return jsonb_build_object('reservationId', p_reservation_id, 'status', 'reserved',
                            'reservedUsd', p_estimate_usd, 'replayed', false);
end;
$$;

create or replace function public.settle_ai_budget(
  p_reservation_id uuid,
  p_actual_usd numeric,
  p_generation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_reservation app.ai_budget_reservations;
  v_log_id uuid;
  v_community_id text;
  v_post_id text;
  v_job_id uuid;
  v_status text;
begin
  if p_reservation_id is null
     or p_actual_usd is null
     or p_actual_usd::text in ('NaN','Infinity','-Infinity')
     or p_actual_usd < 0
     or p_actual_usd > 10000
     or p_generation is null then
    raise exception 'Некорректный результат расчёта AI-бюджета; резерв сохранён' using errcode = '22023';
  end if;

  select * into v_reservation
    from app.ai_budget_reservations
   where id = p_reservation_id
   for update;
  if not found then
    raise exception 'Резерв AI-бюджета не найден' using errcode = 'P0002';
  end if;
  if v_reservation.status = 'settled' then
    select id into v_log_id from public.ai_generations where budget_reservation_id = p_reservation_id;
    return jsonb_build_object('status', 'settled', 'generationId', v_log_id, 'replayed', true);
  end if;
  if v_reservation.status <> 'reserved' then
    raise exception 'Резерв AI-бюджета уже закрыт' using errcode = '23514';
  end if;

  insert into app.ai_budget_periods (month_start, reserved_usd)
  values (v_reservation.month_start, 0)
  on conflict (month_start) do nothing;
  perform 1 from app.ai_budget_periods where month_start = v_reservation.month_start for update;

  v_community_id := nullif(p_generation ->> 'communityId', '');
  if v_community_id is not null and not exists (select 1 from public.communities where id = v_community_id) then
    v_community_id := null;
  end if;
  v_post_id := nullif(p_generation ->> 'postId', '');
  if v_post_id is not null and not exists (select 1 from public.posts where id = v_post_id) then
    v_post_id := null;
  end if;
  if coalesce(p_generation ->> 'jobId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_job_id := (p_generation ->> 'jobId')::uuid;
  end if;
  v_status := case when p_generation ->> 'status' = 'done' then 'done' else 'error' end;

  insert into public.ai_generations (
    community_id, post_id, job_id, type, provider, model, prompt, result,
    cost_usd, cost_estimated, status, error, created_at, budget_reservation_id
  ) values (
    v_community_id,
    v_post_id,
    v_job_id,
    left(coalesce(nullif(p_generation ->> 'type', ''), 'unknown'), 40),
    left(coalesce(nullif(p_generation ->> 'provider', ''), 'unknown'), 80),
    left(coalesce(nullif(p_generation ->> 'model', ''), 'unknown'), 160),
    left(coalesce(p_generation ->> 'prompt', ''), 4000),
    left(coalesce(p_generation ->> 'result', ''), 8000),
    p_actual_usd,
    coalesce((p_generation ->> 'costEstimated')::boolean, true),
    v_status,
    left(nullif(p_generation ->> 'error', ''), 500),
    v_reservation.created_at,
    p_reservation_id
  ) returning id into v_log_id;

  update app.ai_budget_periods
     set reserved_usd = greatest(0, reserved_usd - v_reservation.reserved_usd),
         updated_at = now()
   where month_start = v_reservation.month_start;
  update app.ai_budget_reservations
     set status = 'settled', actual_usd = p_actual_usd, resolved_at = now(),
         resolution_note = 'Settled atomically with ai_generations ledger row'
   where id = p_reservation_id and status = 'reserved';

  return jsonb_build_object('status', 'settled', 'generationId', v_log_id,
                            'reservedUsd', v_reservation.reserved_usd,
                            'actualUsd', p_actual_usd, 'replayed', false);
end;
$$;

create or replace function public.release_ai_budget(p_reservation_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_reservation app.ai_budget_reservations;
begin
  select * into v_reservation from app.ai_budget_reservations where id = p_reservation_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_reservation.status = 'released' then
    return jsonb_build_object('status', 'released', 'replayed', true);
  end if;
  if v_reservation.status <> 'reserved' then
    raise exception 'Закрытый или потраченный резерв нельзя освобождать' using errcode = '23514';
  end if;

  perform 1 from app.ai_budget_periods where month_start = v_reservation.month_start for update;
  update app.ai_budget_periods
     set reserved_usd = greatest(0, reserved_usd - v_reservation.reserved_usd), updated_at = now()
   where month_start = v_reservation.month_start;
  update app.ai_budget_reservations
     set status = 'released', resolved_at = now(), resolution_note = left(coalesce(p_reason, ''), 300)
   where id = p_reservation_id and status = 'reserved';
  return jsonb_build_object('status', 'released', 'replayed', false);
end;
$$;

revoke all on function public.reserve_ai_budget(uuid,numeric) from public, anon, authenticated;
revoke all on function public.settle_ai_budget(uuid,numeric,jsonb) from public, anon, authenticated;
revoke all on function public.release_ai_budget(uuid,text) from public, anon, authenticated;
grant execute on function public.reserve_ai_budget(uuid,numeric) to service_role;
grant execute on function public.settle_ai_budget(uuid,numeric,jsonb) to service_role;
grant execute on function public.release_ai_budget(uuid,text) to service_role;

commit;
