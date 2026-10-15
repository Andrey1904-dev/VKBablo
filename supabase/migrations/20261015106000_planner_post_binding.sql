-- Bind generated planner results to their slot post; retain Moscow slots.
create or replace function public.enqueue_upcoming_generations(p_hours int default null)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid;
  v_hours int;
  v_count int := 0;
  r record;
  r2 record;
  v_post_id text;
begin
  -- Может вызываться владельцем (v_uid есть) или воркером (service role, v_uid = null).
  if auth.uid() is not null then
    v_uid := app.assert_owner();
  end if;

  if app.get_bool_setting('automation_paused', false) then
    return jsonb_build_object('queued', 0, 'paused', true);
  end if;

  v_hours := coalesce(p_hours, coalesce(nullif(app.get_setting('prepare_hours_ahead', '24'), '')::int, 24));

  for r in
    select c.id as community_id, c.schedule
      from public.communities c
      join public.schedules s on s.community_id = c.id
     where c.status = 'active'
       and c.automation_enabled
       and not s.paused
       and (s.skip_until is null or s.skip_until < current_date)
  loop
    -- Слоты считаются в PostgreSQL по Europe/Moscow, без доверия данным браузера.
    for r2 in (
      with slots as (
        select (jsonb_array_elements_text(r.schedule))::time as slot_time
      ), days as (
        select generate_series(current_date, (current_date + make_interval(days => greatest(1, (v_hours / 24) + 1))), interval '1 day')::date as day
      )
      select ((d.day + s.slot_time) at time zone 'Europe/Moscow') as scheduled_at
        from days d cross join slots s
    )
    loop
      continue when r2.scheduled_at is null;
      continue when r2.scheduled_at <= now();
      continue when r2.scheduled_at > now() + make_interval(hours => v_hours);
      continue when exists (
        select 1 from public.posts p
         where p.community_id = r.community_id
           and p.scheduled_at = r2.scheduled_at
           and p.status <> 'rejected'
      );

      -- Create the slot first and bind its job to the exact post. Both writes
      -- share this transaction; planner jobs must never finish without a post.
      insert into public.posts (id, community_id, status, scheduled_at, title, text, image_prompt, topic, idea, test_mode)
      values ('post_' || encode(extensions.gen_random_bytes(9), 'hex'), r.community_id, 'generating',
              r2.scheduled_at, '', '', '', '', '', true)
      on conflict do nothing returning id into v_post_id;
      if v_post_id is null then continue; end if;

      insert into public.generation_jobs (community_id, post_id, kind, payload, idempotency_key, created_by)
      values (
        r.community_id, v_post_id, 'full_post',
        jsonb_build_object('scheduledAt', r2.scheduled_at, 'source', 'planner'),
        'gen:' || r.community_id || ':' || to_char(r2.scheduled_at at time zone 'UTC', 'YYYYMMDDHH24MI') || ':full_post',
        v_uid
      )
      on conflict (idempotency_key) do update
        set post_id = coalesce(generation_jobs.post_id, excluded.post_id);

      if found then
        v_count := v_count + 1;
      end if;

    end loop;
  end loop;

  perform app.log_audit('planner_enqueue', 'generation_jobs', null, jsonb_build_object('queued', v_count));
  perform app.set_setting('planner_last_run_at', now()::text);
  return jsonb_build_object('queued', v_count, 'hours', v_hours);
end;
$$;
