-- Owner is a distinct security boundary. Editors can work with operational
-- content, but cannot inspect/change integrations, API keys, security settings,
-- audit/user management, or invoke owner-only publication controls.

create or replace function app.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.role = 'owner'
  );
$$;

create or replace function app.is_editor()
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.role in ('owner','editor')
  );
$$;

create or replace function app.assert_owner()
returns uuid
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Требуется авторизация' using errcode = '42501';
  end if;
  if not app.is_owner() then
    raise exception 'Недостаточно прав: нужна роль владельца' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

create or replace function app.assert_editor()
returns uuid
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Требуется авторизация' using errcode = '42501';
  end if;
  if not app.is_editor() then
    raise exception 'Недостаточно прав: нужна роль редактора или владельца' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

revoke all on function app.is_owner() from public, anon;
revoke all on function app.is_editor() from public, anon;
revoke all on function app.assert_owner() from public, anon, authenticated;
revoke all on function app.assert_editor() from public, anon, authenticated;
grant execute on function app.is_owner() to authenticated;
grant execute on function app.is_editor() to authenticated;

-- Profiles remain self-readable to editors; only owners can list other users.
drop policy if exists profiles_read_own on public.profiles;
create policy profiles_read_own on public.profiles
  for select to authenticated
  using (id = auth.uid() or app.is_owner());
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
grant select on public.profiles to authenticated;

-- Role assignment has no browser API: profile updates cannot promote/demote
-- the caller, and the one-time bootstrap/service administration is the trusted path.
create or replace function app.guard_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  if new.role is distinct from old.role and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Изменять роли пользователей может только доверенный серверный процесс'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_role_immutable on public.profiles;
create trigger profiles_role_immutable before update of role on public.profiles
  for each row execute function app.guard_profile_role_change();
revoke all on function app.guard_profile_role_change() from public, anon, authenticated;

-- RLS read separation: operational tables are shared with editors; integration
-- state, settings, and audit history stay owner-only. Secrets remain service-only.
do $$
declare
  t text;
  editor_readable text[] := array[
    'communities','schedules','community_rules','community_rule_versions',
    'characters','character_references','posts','post_versions','approvals','topics',
    'media_assets','ai_providers','ai_prompt_templates','ai_generations',
    'generation_jobs','publication_jobs','jobs','post_statistics','analytics_snapshots',
    'notifications'
  ];
  owner_readable text[] := array['integration_status','audit_logs','application_settings'];
begin
  foreach t in array editor_readable loop
    execute format('drop policy if exists %I on public.%I', t || '_owner_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_editor_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (app.is_editor())',
      t || '_editor_read', t
    );
    execute format('grant select on public.%I to authenticated', t);
  end loop;

  foreach t in array owner_readable loop
    execute format('drop policy if exists %I on public.%I', t || '_editor_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (app.is_owner())',
      t || '_owner_read', t
    );
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- Storage upsert invokes UPDATE. With no authenticated UPDATE policy, editors and
-- owners alike must upload under a fresh path; deletions still go through service.
drop policy if exists media_owner_read on storage.objects;
drop policy if exists media_owner_insert on storage.objects;
drop policy if exists media_owner_update on storage.objects;
drop policy if exists media_owner_delete on storage.objects;
drop policy if exists media_editor_read on storage.objects;
drop policy if exists media_editor_insert on storage.objects;
create policy media_editor_read on storage.objects
  for select to authenticated
  using (bucket_id = 'media' and app.is_editor());
create policy media_editor_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'media'
    and app.is_editor()
    and (storage.foldername(name))[1] in ('communities','characters','posts','generated','archive')
  );

-- Existing content-editing RPCs move from the old overloaded owner helper to
-- the explicit editor helper. Approval, scheduling, integrations, characters,
-- settings, and publication-worker functions deliberately remain owner/service-only.
do $$
declare
  r record;
  v_definition text;
  v_count integer := 0;
  v_seen integer := 0;
  editor_functions text[] := array[
    'create_manual_post','save_post_edit','reject_post','request_revision',
    'enqueue_generation','enqueue_regeneration','save_community_rules',
    'mark_notifications_read','import_analytics','analytics_overview'
  ];
begin
  for r in
    select p.oid, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = any(editor_functions)
  loop
    v_seen := v_seen + 1;
    v_definition := pg_get_functiondef(r.oid);
    if position('app.assert_owner()' in v_definition) > 0 then
      v_definition := replace(v_definition, 'app.assert_owner()', 'app.assert_editor()');
      execute v_definition;
      v_count := v_count + 1;
    elsif position('app.assert_editor()' in v_definition) = 0 then
      raise exception 'Cannot verify editor check in public.%', r.proname;
    end if;
  end loop;

  if v_seen <> cardinality(editor_functions) then
    raise exception 'Expected % editor RPC functions, found %', cardinality(editor_functions), v_seen;
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname = any(editor_functions)
       and pg_get_functiondef(p.oid) not like '%app.assert_editor()%'
  ) then
    raise exception 'At least one editor RPC lacks app.assert_editor()';
  end if;
end $$;

-- Settings and AI cost are not available through a direct RPC to an editor.
create or replace function public.get_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
begin
  perform app.assert_owner();
  return jsonb_build_object(
    'mode', app.get_setting('app_mode', 'test'),
    'automationPaused', app.get_bool_setting('automation_paused', false),
    'realPublishEnabled', app.get_bool_setting('real_publish_enabled', false),
    'timezone', app.get_setting('timezone', 'Europe/Moscow'),
    'prepareHoursAhead', coalesce(nullif(app.get_setting('prepare_hours_ahead', '24'), '')::int, 24),
    'aiMonthlyLimitUsd', coalesce(nullif(app.get_setting('ai_monthly_limit_usd', '20'), '')::numeric, 20),
    'spendUsdMonth', public.month_spend_usd(),
    'aiProvider', app.get_setting('ai_provider', 'test'),
    'aiTextModel', app.get_setting('ai_text_model', 'test-writer-v1'),
    'aiImageModel', app.get_setting('ai_image_model', 'test-illustrator-v1'),
    'aiBaseUrl', app.get_setting('ai_base_url', ''),
    'notificationsEnabled', app.get_bool_setting('notifications_enabled', true),
    'updatedAt', app.get_setting('settings_updated_at', null)
  );
end;
$$;

create or replace function public.missed_slots(p_lookback_days int default 2)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_result jsonb;
begin
  perform app.assert_editor();
  select coalesce(jsonb_agg(x order by x.scheduled_at), '[]'::jsonb) into v_result from (
    select c.id as community_id, ((d.day + s.slot_time) at time zone 'Europe/Moscow') as scheduled_at
      from public.communities c
      join public.schedules sc on sc.community_id = c.id
      cross join lateral jsonb_array_elements_text(c.schedule) as s(slot_time)
      cross join lateral generate_series(
        (current_date - make_interval(days => greatest(0, p_lookback_days)))::date,
        current_date,
        interval '1 day'
      ) as d(day)
     where ((d.day + (s.slot_time)::time) at time zone 'Europe/Moscow') < now()
       and not exists (
         select 1 from public.posts p
          where p.community_id = c.id
            and p.scheduled_at = ((d.day + (s.slot_time)::time) at time zone 'Europe/Moscow')
            and p.status in ('scheduled','published','approved','review','generating','needs_revision')
       )
  ) x;
  return v_result;
end;
$$;

-- The dashboard remains available to editors, but omits integrations, security
-- settings, and AI spend instead of leaking them through a SECURITY DEFINER RPC.
create or replace function public.dashboard_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_result jsonb;
  v_is_owner boolean;
begin
  perform app.assert_editor();
  v_is_owner := app.is_owner();

  select jsonb_build_object(
    'counts', coalesce((
      select jsonb_object_agg(status, c) from (
        select status, count(*)::int as c from public.posts group by status
      ) s
    ), '{}'::jsonb),
    'byCommunity', coalesce((
      select jsonb_agg(x) from (
        select c.id, c.name, c.color,
               count(*) filter (where p.status in ('review','needs_revision'))::int as pending,
               count(*) filter (where p.status in ('scheduled','approved'))::int as scheduled,
               count(*) filter (where p.status = 'published')::int as published,
               count(*) filter (where p.status = 'error')::int as errors
          from public.communities c left join public.posts p on p.community_id = c.id
         group by c.id, c.name, c.color order by c.name
      ) x
    ), '[]'::jsonb),
    'nextPosts', coalesce((
      select jsonb_agg(z) from (
        select to_jsonb(p) as post from public.posts p
         where p.scheduled_at >= now() order by p.scheduled_at asc limit 8
      ) z
    ), '[]'::jsonb),
    'jobs', coalesce((
      select jsonb_agg(j) from (
        select id, type, status, attempts, max_attempts as "maxAttempts", run_at as "runAt",
               error, idempotency_key as "idempotencyKey", created_at as "createdAt"
          from (
            select id::text, kind as type, status, attempts, max_attempts, run_at, error, idempotency_key, created_at
              from public.generation_jobs
            union all
            select id::text, 'publication' as type, status, attempts, max_attempts, run_at, last_error as error,
                   idempotency_key, created_at
              from public.publication_jobs
          ) alljobs order by created_at desc limit 20
      ) j
    ), '[]'::jsonb),
    'missedSlots', jsonb_array_length(public.missed_slots(2)),
    'spendUsdMonth', case when v_is_owner then public.month_spend_usd() else null end,
    'unreadNotifications', (select count(*) from public.notifications where read = false),
    'integrations', case when v_is_owner
      then coalesce((select jsonb_agg(to_jsonb(i)) from public.integration_status i), '[]'::jsonb)
      else '[]'::jsonb end,
    'settings', case when v_is_owner then public.get_settings() else '{}'::jsonb end
  ) into v_result;
  return v_result;
end;
$$;

-- Keep browser-facing rights consistent with the role checks inside the RPCs.
revoke all on function public.set_integration_status(text,text,text,boolean,boolean) from public, anon, authenticated;
grant execute on function public.set_integration_status(text,text,text,boolean,boolean) to service_role;

grant execute on function public.dashboard_overview() to authenticated;
grant execute on function public.analytics_overview() to authenticated;
grant execute on function public.get_settings() to authenticated;
revoke all on function public.month_spend_usd() from public, anon, authenticated;
grant execute on function public.month_spend_usd() to service_role;
grant execute on function public.missed_slots(integer) to authenticated;
