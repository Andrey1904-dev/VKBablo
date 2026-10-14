-- =============================================================================
-- VK AI Manager — серверные RPC-функции (реальная бизнес-логика)
--
-- Здесь живут транзакционные инварианты ТЗ:
--   • §9  ручное одобрение обязательно; невозможна отправка без действующего одобрения;
--   • §9  изменение текста/картинки/времени/сообщества сбрасывает одобрение (триггер + эти функции);
--   • §8  защита от повторных задач (idempotency_key) и дублей слотов (уникальный индекс);
--   • §15 идемпотентные очереди с блокировками (FOR UPDATE SKIP LOCKED), ретраями и журналом;
--   • §18 серверная проверка полномочий и аудит критических действий.
--
-- Пользовательские функции вызываются с JWT владельца (`authenticated`).
-- Служебные функции (очереди, публикация, статистика) — только service role.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Внутренние помощники
-- ---------------------------------------------------------------------------
create or replace function app.notify(
  p_type text, p_title text, p_message text default '', p_link text default null
)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  insert into public.notifications (type, title, message, link)
  values (p_type, p_title, coalesce(p_message, ''), p_link);
end;
$$;

create or replace function app.check_rate_limit(
  p_subject text, p_bucket text, p_limit int, p_window_seconds int
)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_row public.rate_limits;
begin
  select * into v_row from public.rate_limits
   where subject = p_subject and bucket = p_bucket for update;

  if v_row is null or v_row.window_start < now() - make_interval(secs => p_window_seconds) then
    insert into public.rate_limits (subject, bucket, window_start, hits)
    values (p_subject, p_bucket, now(), 1)
    on conflict (subject, bucket) do update
      set window_start = now(), hits = 1;
    return;
  end if;

  if v_row.hits >= p_limit then
    raise exception 'Слишком много запросов. Повторите позже.'
      using errcode = '42901';
  end if;

  update public.rate_limits set hits = hits + 1
   where subject = p_subject and bucket = p_bucket;
end;
$$;

create or replace function app.post_json(p_post_id text)
returns jsonb
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select to_jsonb(p) from public.posts p where p.id = p_post_id;
$$;

comment on function app.post_json(text) is 'Сериализация публикации для ответов RPC.';

-- ---------------------------------------------------------------------------
-- Публикации: создание, правка, одобрение, отклонение, доработка
-- ---------------------------------------------------------------------------
create or replace function public.create_manual_post(
  p_community_id text,
  p_scheduled_at timestamptz,
  p_title text default '',
  p_text text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid;
  v_id text;
begin
  v_uid := app.assert_owner();
  perform app.check_rate_limit(v_uid::text, 'posts', 30, 60);

  if not exists (select 1 from public.communities where id = p_community_id) then
    raise exception 'Неизвестное сообщество: %', p_community_id using errcode = '23503';
  end if;

  if p_scheduled_at is null then
    raise exception 'Не задано время публикации' using errcode = '22004';
  end if;

  if exists (
    select 1 from public.posts
    where community_id = p_community_id and scheduled_at = p_scheduled_at and status <> 'rejected'
  ) then
    raise exception 'Слот занят: % %', p_community_id, p_scheduled_at using errcode = '23505';
  end if;

  v_id := 'post_' || encode(gen_random_bytes(9), 'hex');

  insert into public.posts (
    id, community_id, status, scheduled_at, title, text, image_prompt, topic, idea, test_mode, version
  ) values (
    v_id, p_community_id, 'draft', p_scheduled_at,
    coalesce(nullif(p_title, ''), 'Черновик'), coalesce(p_text, ''),
    '', coalesce(nullif(p_title, ''), 'Черновик'), '', true, 1
  );

  insert into public.post_versions (post_id, version, text, content_hash, reason, created_by)
  select p.id, p.version, p.text, p.content_hash, 'create', v_uid from public.posts p where p.id = v_id;

  perform app.log_audit('create_draft', 'post', v_id, jsonb_build_object('community', p_community_id));
  return app.post_json(v_id);
end;
$$;

create or replace function public.save_post_edit(
  p_post_id text,
  p_text text default null,
  p_image_path text default null,
  p_scheduled_at timestamptz default null,
  p_title text default null,
  p_reason text default 'edit'
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid;
  v_before public.posts;
  v_after public.posts;
  v_slot_taken boolean;
begin
  v_uid := app.assert_owner();
  perform app.check_rate_limit(v_uid::text, 'posts', 30, 60);

  select * into v_before from public.posts where id = p_post_id for update;
  if v_before is null then
    raise exception 'Публикация не найдена' using errcode = 'P0002';
  end if;
  if v_before.status = 'published' then
    raise exception 'Опубликованный пост нельзя редактировать — создайте новую публикацию'
      using errcode = '23514';
  end if;

  if p_scheduled_at is not null and p_scheduled_at <> v_before.scheduled_at then
    select exists (
      select 1 from public.posts
      where community_id = v_before.community_id
        and scheduled_at = p_scheduled_at
        and id <> p_post_id
        and status <> 'rejected'
    ) into v_slot_taken;
    if v_slot_taken then
      raise exception 'Слот занят другим постом' using errcode = '23505';
    end if;
  end if;

  -- Сохраняем предыдущую версию перед изменением.
  insert into public.post_versions (post_id, version, text, image_path, image_prompt, content_hash, reason, created_by)
  values (v_before.id, v_before.version, v_before.text, v_before.image_path, v_before.image_prompt,
          v_before.content_hash, p_reason, v_uid);

  update public.posts
     set text = coalesce(p_text, text),
         image_path = case when p_image_path is null then image_path
                           when p_image_path = '' then null
                           else p_image_path end,
         scheduled_at = coalesce(p_scheduled_at, scheduled_at),
         title = coalesce(p_title, title),
         version = version + 1,
         error_message = null
   where id = p_post_id
   returning * into v_after;

  insert into public.post_versions (post_id, version, text, image_path, image_prompt, content_hash, reason, created_by)
  values (v_after.id, v_after.version, v_after.text, v_after.image_path, v_after.image_prompt,
          v_after.content_hash, 'edit', v_uid);

  if v_after.content_hash <> v_before.content_hash then
    perform app.log_audit('approval_reset', 'post', p_post_id,
      jsonb_build_object('reason', p_reason, 'oldHash', left(v_before.content_hash, 12),
                         'newHash', left(v_after.content_hash, 12)));

    if v_before.approved_hash is not null then
      perform app.notify('review', 'Нужно новое одобрение',
        'Публикация "' || coalesce(nullif(v_after.title, ''), v_after.topic) || '" изменена и снова на проверке.',
        '/posts/' || p_post_id);
    end if;
  end if;

  perform app.log_audit(p_reason, 'post', p_post_id, jsonb_build_object('version', v_after.version));
  return app.post_json(p_post_id);
end;
$$;

create or replace function public.approve_post(p_post_id text, p_comment text default '')
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid;
  v_post public.posts;
  v_hash text;
begin
  v_uid := app.assert_owner();
  perform app.check_rate_limit(v_uid::text, 'approvals', 30, 60);

  select * into v_post from public.posts where id = p_post_id for update;
  if v_post is null then
    raise exception 'Публикация не найдена' using errcode = 'P0002';
  end if;
  if v_post.status not in ('review', 'needs_revision', 'draft', 'approved') then
    raise exception 'Эту публикацию нельзя одобрить в статусе "%"', v_post.status using errcode = '23514';
  end if;
  if btrim(coalesce(v_post.text, '')) = '' then
    raise exception 'Пустой текст нельзя одобрить' using errcode = '23514';
  end if;
  if coalesce(v_post.image_path, '') = '' then
    raise exception 'Нужно изображение: без картинки публикация не одобряется' using errcode = '23514';
  end if;

  v_hash := app.content_hash(v_post.community_id, v_post.text, v_post.image_path, v_post.scheduled_at);

  update public.posts
     set status = 'approved',
         approved_hash = v_hash,
         content_hash = v_hash,
         approved_at = now(),
         approved_by = v_uid,
         test_mode = not app.get_bool_setting('real_publish_enabled', false),
         error_message = null
   where id = p_post_id;

  insert into public.approvals (post_id, version_hash, action, comment, user_id)
  values (p_post_id, v_hash, 'approve', coalesce(p_comment, ''), v_uid);

  perform app.log_audit('approve', 'post', p_post_id, jsonb_build_object('hash', v_hash));
  return app.post_json(p_post_id);
end;
$$;

create or replace function public.reject_post(p_post_id text, p_comment text default '')
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid;
  v_post public.posts;
begin
  v_uid := app.assert_owner();
  select * into v_post from public.posts where id = p_post_id for update;
  if v_post is null then
    raise exception 'Публикация не найдена' using errcode = 'P0002';
  end if;
  if v_post.status = 'published' then
    raise exception 'Опубликованное нельзя отклонить' using errcode = '23514';
  end if;

  update public.posts
     set status = 'rejected',
         approved_hash = null,
         approved_at = null,
         approved_by = null,
         vk_post_id = null,
         error_message = null
   where id = p_post_id;

  insert into public.approvals (post_id, version_hash, action, comment, user_id)
  values (p_post_id, v_post.content_hash, 'reject', coalesce(p_comment, ''), v_uid);

  perform app.log_audit('reject', 'post', p_post_id, jsonb_build_object('comment', p_comment));
  return app.post_json(p_post_id);
end;
$$;

create or replace function public.request_revision(
  p_post_id text, p_comment text default '', p_scope text default 'all'
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid;
  v_post public.posts;
  v_scope text := case when p_scope in ('text', 'image', 'all') then p_scope else 'all' end;
begin
  v_uid := app.assert_owner();
  select * into v_post from public.posts where id = p_post_id for update;
  if v_post is null then
    raise exception 'Публикация не найдена' using errcode = 'P0002';
  end if;

  update public.posts
     set status = 'needs_revision',
         approved_hash = null,
         approved_at = null,
         approved_by = null,
         error_message = 'Доработка (' || v_scope || '): ' || coalesce(p_comment, '')
   where id = p_post_id;

  insert into public.approvals (post_id, version_hash, action, comment, user_id)
  values (p_post_id, v_post.content_hash, 'revise', v_scope || ': ' || coalesce(p_comment, ''), v_uid);

  perform app.log_audit('revise', 'post', p_post_id,
    jsonb_build_object('scope', v_scope, 'comment', p_comment));
  return app.post_json(p_post_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- §9 + §8: планирование в VK. Без действующего одобрения — невозможно.
-- ---------------------------------------------------------------------------
create or replace function public.schedule_post(p_post_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid;
  v_post public.posts;
  v_dry_run boolean;
  v_key text;
  v_job public.publication_jobs;
  v_group text;
begin
  v_uid := app.assert_owner();
  perform app.check_rate_limit(v_uid::text, 'approvals', 30, 60);

  if app.get_bool_setting('automation_paused', false) then
    raise exception 'Автоматизация на паузе. Снимите паузу, чтобы планировать публикации.'
      using errcode = '42501';
  end if;

  select * into v_post from public.posts where id = p_post_id for update;
  if v_post is null then
    raise exception 'Публикация не найдена' using errcode = 'P0002';
  end if;

  -- Гейт одобрения (дублирует проверку из shared/approval.ts).
  if v_post.approved_hash is null then
    raise exception 'Публикация без одобрения невозможна' using errcode = '42501';
  end if;
  if v_post.approved_hash <> v_post.content_hash then
    raise exception 'Одобрение не соответствует текущей версии контента' using errcode = '42501';
  end if;
  if v_post.status not in ('approved', 'scheduled') then
    raise exception 'Статус "%" не позволяет отправку в VK', v_post.status using errcode = '42501';
  end if;
  if v_post.scheduled_at < now() + interval '60 seconds' then
    raise exception 'Время публикации уже прошло или слишком близко' using errcode = '23514';
  end if;

  v_dry_run := app.get_setting('app_mode', 'test') <> 'approval'
               or not app.get_bool_setting('real_publish_enabled', false);

  select c.vk_group_id into v_group from public.communities c where c.id = v_post.community_id;
  if not v_dry_run and coalesce(v_group, '') = '' then
    raise exception 'Сообщество не подключено к VK: укажите Group ID и токен'
      using errcode = '23514';
  end if;

  v_key := 'pub:' || v_post.id || ':' || v_post.approved_hash;

  select * into v_job from public.publication_jobs where idempotency_key = v_key;
  if v_job is not null and v_job.status in ('done', 'running', 'queued') then
    raise exception 'Эта версия уже отправлена или отправляется' using errcode = '23505';
  end if;

  insert into public.publication_jobs (
    post_id, community_id, version_hash, scheduled_at, dry_run, idempotency_key
  ) values (
    v_post.id, v_post.community_id, v_post.approved_hash, v_post.scheduled_at, v_dry_run, v_key
  )
  on conflict (idempotency_key) do update
    set status = 'queued', run_at = now(), last_error = null
  returning * into v_job;

  update public.posts
     set status = 'scheduled',
         test_mode = v_dry_run,
         error_message = null
   where id = p_post_id;

  perform app.log_audit('schedule', 'post', p_post_id,
    jsonb_build_object('job', v_job.id, 'dryRun', v_dry_run, 'hash', v_post.approved_hash));

  perform app.notify(
    'scheduled',
    case when v_dry_run then 'Пост запланирован (dry-run)' else 'Пост запланирован в VK' end,
    coalesce(nullif(v_post.title, ''), v_post.topic),
    '/posts/' || p_post_id
  );

  return jsonb_build_object('post', app.post_json(p_post_id), 'jobId', v_job.id, 'dryRun', v_dry_run);
end;
$$;

create or replace function public.unschedule_post(p_post_id text, p_reason text default '')
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid;
  v_post public.posts;
begin
  v_uid := app.assert_owner();
  select * into v_post from public.posts where id = p_post_id for update;
  if v_post is null then
    raise exception 'Публикация не найдена' using errcode = 'P0002';
  end if;
  if v_post.status = 'published' then
    raise exception 'Опубликованный пост нельзя снять с планирования' using errcode = '23514';
  end if;

  update public.publication_jobs
     set status = 'cancelled', last_error = coalesce(p_reason, 'отменено владельцем')
   where post_id = p_post_id and status in ('queued', 'running');

  update public.posts
     set status = case when approved_hash is not null then 'approved' else 'review' end,
         vk_post_id = null
   where id = p_post_id;

  perform app.log_audit('unschedule', 'post', p_post_id, jsonb_build_object('reason', p_reason));
  return app.post_json(p_post_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Очередь генерации
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_generation(
  p_community_id text,
  p_scheduled_at timestamptz,
  p_kind text default 'full_post',
  p_force boolean default false,
  p_prompt text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid;
  v_post public.posts;
  v_job public.generation_jobs;
  v_post_id text;
  v_key text;
  v_kind text := case when p_kind in ('idea','text','image','full_post','regenerate','preview')
                      then p_kind else 'full_post' end;
begin
  v_uid := app.assert_owner();
  perform app.check_rate_limit(v_uid::text, 'generations', 10, 60);

  if app.get_bool_setting('automation_paused', false) then
    raise exception 'Автоматизация на паузе' using errcode = '42501';
  end if;
  if not exists (select 1 from public.communities where id = p_community_id) then
    raise exception 'Неизвестное сообщество: %', p_community_id using errcode = '23503';
  end if;
  if p_scheduled_at is null then
    raise exception 'Не задано время слота' using errcode = '22004';
  end if;

  select * into v_post from public.posts
   where community_id = p_community_id and scheduled_at = p_scheduled_at
   order by created_at desc limit 1
   for update;

  if v_post is not null and v_post.status in ('approved', 'scheduled', 'published') and not p_force then
    return jsonb_build_object('skipped', true, 'reason', 'slot_already_approved', 'post', app.post_json(v_post.id));
  end if;

  if v_post is null then
    v_post_id := 'post_' || encode(gen_random_bytes(9), 'hex');
    insert into public.posts (id, community_id, status, scheduled_at, title, text, image_prompt, topic, idea, test_mode)
    values (v_post_id, p_community_id, 'generating', p_scheduled_at, '', '', '', '', '', true);
  else
    v_post_id := v_post.id;
    update public.posts set status = 'generating', error_message = null where id = v_post_id;
  end if;

  v_key := 'gen:' || p_community_id || ':' || to_char(p_scheduled_at at time zone 'UTC', 'YYYYMMDDHH24MI') || ':' || v_kind;

  insert into public.generation_jobs (community_id, post_id, kind, payload, idempotency_key, created_by)
  values (
    p_community_id, v_post_id, v_kind,
    jsonb_build_object('scheduledAt', p_scheduled_at, 'prompt', p_prompt, 'force', p_force),
    v_key, v_uid
  )
  on conflict (idempotency_key) do update
    set status = case when public.generation_jobs.status in ('done') and not p_force
                      then public.generation_jobs.status else 'queued' end,
        run_at = now(),
        payload = excluded.payload,
        error = null
  returning * into v_job;

  perform app.log_audit('enqueue_generation', 'post', v_post_id,
    jsonb_build_object('job', v_job.id, 'kind', v_kind));

  return jsonb_build_object('jobId', v_job.id, 'postId', v_post_id, 'status', v_job.status);
end;
$$;

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

      insert into public.generation_jobs (community_id, kind, payload, idempotency_key, created_by)
      values (
        r.community_id, 'full_post',
        jsonb_build_object('scheduledAt', r2.scheduled_at, 'source', 'planner'),
        'gen:' || r.community_id || ':' || to_char(r2.scheduled_at at time zone 'UTC', 'YYYYMMDDHH24MI') || ':full_post',
        v_uid
      )
      on conflict (idempotency_key) do nothing;

      if found then
        v_count := v_count + 1;
      end if;

      -- Заготовка поста, чтобы слот был занят и не создавался дважды.
      if not exists (
        select 1 from public.posts p
         where p.community_id = r.community_id and p.scheduled_at = r2.scheduled_at and p.status <> 'rejected'
      ) then
        insert into public.posts (id, community_id, status, scheduled_at, title, text, image_prompt, topic, idea, test_mode)
        values ('post_' || encode(gen_random_bytes(9), 'hex'), r.community_id, 'generating',
                r2.scheduled_at, '', '', '', '', '', true)
        on conflict do nothing;
      end if;
    end loop;
  end loop;

  perform app.log_audit('planner_enqueue', 'generation_jobs', null, jsonb_build_object('queued', v_count));
  perform app.set_setting('planner_last_run_at', now()::text);
  return jsonb_build_object('queued', v_count, 'hours', v_hours);
end;
$$;

create or replace function public.enqueue_regeneration(p_post_id text, p_scope text default 'all')
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid;
  v_post public.posts;
  v_kind text;
  v_job public.generation_jobs;
begin
  v_uid := app.assert_owner();
  perform app.check_rate_limit(v_uid::text, 'generations', 10, 60);

  select * into v_post from public.posts where id = p_post_id for update;
  if v_post is null then
    raise exception 'Публикация не найдена' using errcode = 'P0002';
  end if;
  if v_post.status in ('published', 'scheduled') then
    raise exception 'Сначала снимите публикацию с планирования' using errcode = '23514';
  end if;

  insert into public.post_versions (post_id, version, text, image_path, image_prompt, content_hash, reason, created_by)
  values (v_post.id, v_post.version, v_post.text, v_post.image_path, v_post.image_prompt,
          v_post.content_hash, 'regenerate:' || p_scope, v_uid);

  v_kind := case when p_scope = 'image' then 'image' when p_scope = 'text' then 'text' else 'regenerate' end;

  update public.posts set status = 'generating', approved_hash = null, approved_at = null,
         approved_by = null, error_message = null
   where id = p_post_id;

  insert into public.generation_jobs (community_id, post_id, kind, payload, idempotency_key, created_by)
  values (
    v_post.community_id, p_post_id, v_kind,
    jsonb_build_object('scope', p_scope, 'previousVersion', v_post.version),
    'regen:' || p_post_id || ':' || v_post.version || ':' || p_scope,
    v_uid
  )
  returning * into v_job;

  perform app.log_audit('enqueue_regeneration', 'post', p_post_id,
    jsonb_build_object('job', v_job.id, 'scope', p_scope));
  return jsonb_build_object('jobId', v_job.id, 'postId', p_post_id, 'status', v_job.status);
end;
$$;

create or replace function public.claim_generation_job(
  p_kinds text[] default null, p_worker text default 'worker'
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_job public.generation_jobs;
begin
  if app.get_bool_setting('automation_paused', false) then
    return null;
  end if;

  select * into v_job
    from public.generation_jobs
   where status = 'queued'
     and run_at <= now()
     and (p_kinds is null or kind = any(p_kinds))
   order by priority asc, run_at asc
   for update skip locked
   limit 1;

  if v_job is null then
    return null;
  end if;

  update public.generation_jobs
     set status = 'running',
         attempts = attempts + 1,
         locked_at = now(),
         locked_by = p_worker
   where id = v_job.id
   returning * into v_job;

  return jsonb_build_object(
    'id', v_job.id,
    'communityId', v_job.community_id,
    'postId', v_job.post_id,
    'kind', v_job.kind,
    'attempts', v_job.attempts,
    'maxAttempts', v_job.max_attempts,
    'payload', v_job.payload
  );
end;
$$;

create or replace function public.finish_generation_job(
  p_job_id uuid,
  p_ok boolean,
  p_result jsonb default null,
  p_error text default null,
  p_cost numeric default 0,
  p_provider text default null,
  p_model text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_job public.generation_jobs;
  v_delay int;
begin
  select * into v_job from public.generation_jobs where id = p_job_id for update;
  if v_job is null then
    raise exception 'Задание не найдено' using errcode = 'P0002';
  end if;

  if p_ok then
    update public.generation_jobs
       set status = 'done', result = p_result, error = null, cost_usd = coalesce(p_cost, 0),
           provider = coalesce(p_provider, provider), model = coalesce(p_model, model),
           locked_at = null, locked_by = null
     where id = p_job_id;
    return jsonb_build_object('status', 'done');
  end if;

  if v_job.attempts >= v_job.max_attempts then
    update public.generation_jobs
       set status = 'failed', error = p_error, cost_usd = cost_usd + coalesce(p_cost, 0),
           locked_at = null, locked_by = null
     where id = p_job_id;

    if v_job.post_id is not null then
      update public.posts set status = 'error', error_message = p_error where id = v_job.post_id;
    end if;

    perform app.notify('generation_error', 'Задача генерации провалена',
      coalesce(p_error, 'неизвестная ошибка'), '/settings');
    perform app.log_audit('generation_failed', 'generation_jobs', p_job_id::text,
      jsonb_build_object('error', p_error));
    return jsonb_build_object('status', 'failed');
  end if;

  v_delay := least(15, power(2, v_job.attempts)::int) * 60;

  update public.generation_jobs
     set status = 'queued',
         run_at = now() + make_interval(secs => v_delay),
         error = p_error,
         cost_usd = cost_usd + coalesce(p_cost, 0),
         locked_at = null,
         locked_by = null
   where id = p_job_id;

  return jsonb_build_object('status', 'retry', 'delaySeconds', v_delay);
end;
$$;

create or replace function public.requeue_stale_jobs(p_stale_seconds int default 600)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_gen int;
  v_pub int;
  v_jobs int;
begin
  update public.generation_jobs
     set status = 'queued', locked_at = null, locked_by = null, run_at = now(),
         error = coalesce(error, 'восстановление после сбоя воркера')
   where status = 'running' and locked_at < now() - make_interval(secs => p_stale_seconds);
  get diagnostics v_gen = row_count;

  update public.publication_jobs
     set status = 'queued', locked_at = null, locked_by = null, run_at = now(),
         last_error = coalesce(last_error, 'восстановление после сбоя воркера')
   where status = 'running' and locked_at < now() - make_interval(secs => p_stale_seconds);
  get diagnostics v_pub = row_count;

  update public.jobs
     set status = 'queued', locked_at = null, locked_by = null, run_at = now(),
         error = coalesce(error, 'восстановление после сбоя воркера')
   where status = 'running' and locked_at < now() - make_interval(secs => p_stale_seconds);
  get diagnostics v_jobs = row_count;

  return jsonb_build_object('generation', v_gen, 'publication', v_pub, 'jobs', v_jobs);
end;
$$;

-- ---------------------------------------------------------------------------
-- Очередь публикации (служебные функции — только service role)
-- ---------------------------------------------------------------------------
create or replace function public.claim_publication_job(p_worker text default 'worker')
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_job public.publication_jobs;
  v_post public.posts;
begin
  select * into v_job
    from public.publication_jobs
   where status = 'queued' and run_at <= now()
   order by run_at asc
   for update skip locked
   limit 1;

  if v_job is null then
    return null;
  end if;

  select * into v_post from public.posts where id = v_job.post_id;

  -- Страховка: если одобрение слетело, задача отменяется, а не публикуется.
  if v_post is null
     or v_post.approved_hash is null
     or v_post.approved_hash <> v_post.content_hash
     or v_post.approved_hash <> v_job.version_hash then
    update public.publication_jobs
       set status = 'cancelled', last_error = 'одобрение версии больше не действует'
     where id = v_job.id;
    return jsonb_build_object('cancelled', true, 'jobId', v_job.id);
  end if;

  update public.publication_jobs
     set status = 'running', attempts = attempts + 1, locked_at = now(), locked_by = p_worker
   where id = v_job.id
   returning * into v_job;

  return jsonb_build_object(
    'id', v_job.id,
    'postId', v_job.post_id,
    'communityId', v_job.community_id,
    'versionHash', v_job.version_hash,
    'scheduledAt', v_job.scheduled_at,
    'dryRun', v_job.dry_run,
    'attempts', v_job.attempts,
    'maxAttempts', v_job.max_attempts
  );
end;
$$;

create or replace function public.finish_publication_job(
  p_job_id uuid,
  p_ok boolean,
  p_vk_post_id text default null,
  p_error text default null,
  p_retry_delay_seconds int default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_job public.publication_jobs;
begin
  select * into v_job from public.publication_jobs where id = p_job_id for update;
  if v_job is null then
    raise exception 'Задание публикации не найдено' using errcode = 'P0002';
  end if;

  if p_ok then
    update public.publication_jobs
       set status = 'done', vk_post_id = p_vk_post_id, last_error = null,
           locked_at = null, locked_by = null
     where id = p_job_id;

    update public.posts
       set vk_post_id = coalesce(p_vk_post_id, vk_post_id)
     where id = v_job.post_id;

    perform app.log_audit('vk_scheduled', 'post', v_job.post_id,
      jsonb_build_object('job', p_job_id, 'dryRun', v_job.dry_run, 'vkPostId', p_vk_post_id));
    return jsonb_build_object('status', 'done');
  end if;

  if v_job.attempts >= v_job.max_attempts then
    update public.publication_jobs
       set status = 'failed', last_error = p_error, locked_at = null, locked_by = null
     where id = p_job_id;

    update public.posts set status = 'error', error_message = p_error where id = v_job.post_id;

    perform app.notify('publish_error', 'Ошибка публикации в VK', coalesce(p_error, 'неизвестная ошибка'),
      '/posts/' || v_job.post_id);
    perform app.log_audit('vk_publish_failed', 'post', v_job.post_id, jsonb_build_object('error', p_error));
    return jsonb_build_object('status', 'failed');
  end if;

  update public.publication_jobs
     set status = 'queued',
         run_at = now() + make_interval(secs => greatest(30, p_retry_delay_seconds)),
         last_error = p_error,
         locked_at = null,
         locked_by = null
   where id = p_job_id;

  return jsonb_build_object('status', 'retry');
end;
$$;

create or replace function public.posts_due_for_publication(p_limit int default 10)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select p.id as post_id,
           p.community_id,
           c.vk_group_id,
           p.vk_post_id,
           p.scheduled_at,
           p.test_mode
      from public.posts p
      join public.communities c on c.id = p.community_id
     where p.status = 'scheduled'
       and p.scheduled_at <= now()
     order by p.scheduled_at asc
     limit greatest(1, p_limit)
  ) x;
$$;

create or replace function public.mark_post_published(
  p_post_id text, p_vk_post_id text default null, p_published_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_post public.posts;
begin
  select * into v_post from public.posts where id = p_post_id for update;
  if v_post is null then
    raise exception 'Публикация не найдена' using errcode = 'P0002';
  end if;
  if v_post.approved_hash is null or v_post.approved_hash <> v_post.content_hash then
    raise exception 'Нельзя отметить публикацию как опубликованную без действующего одобрения'
      using errcode = '42501';
  end if;

  update public.posts
     set status = 'published',
         published_at = coalesce(p_published_at, now()),
         vk_post_id = coalesce(p_vk_post_id, vk_post_id)
   where id = p_post_id;

  perform app.notify('published', 'Пост опубликован',
    coalesce(nullif(v_post.title, ''), v_post.topic), '/posts/' || p_post_id);
  perform app.log_audit('published', 'post', p_post_id, jsonb_build_object('vkPostId', p_vk_post_id));
  return app.post_json(p_post_id);
end;
$$;

create or replace function public.posts_due_for_stats(p_limit int default 20)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select p.id as post_id,
           p.community_id,
           p.vk_post_id,
           c.vk_group_id,
           st.last_collected_at
      from public.posts p
      join public.communities c on c.id = p.community_id
      left join lateral (
        select max(s.collected_at) as last_collected_at
          from public.post_statistics s
         where s.post_id = p.id
      ) st on true
     where p.status = 'published'
       and p.vk_post_id is not null
       and p.test_mode = false
       and coalesce(c.vk_group_id, '') <> ''
       -- Не чаще, чем раз в 6 часов, и только для реальных публикаций.
       and (st.last_collected_at is null or st.last_collected_at < now() - interval '6 hours')
     order by p.published_at asc nulls last
     limit greatest(1, p_limit)
  ) x;
$$;

create or replace function public.save_post_statistics(
  p_post_id text,
  p_views int, p_likes int, p_comments int, p_shares int,
  p_source text default 'vk'
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_community text;
begin
  select community_id into v_community from public.posts where id = p_post_id;
  if v_community is null then
    raise exception 'Публикация не найдена' using errcode = 'P0002';
  end if;

  insert into public.post_statistics (post_id, community_id, views, likes, comments, shares, source)
  values (p_post_id, v_community, greatest(0, coalesce(p_views, 0)), greatest(0, coalesce(p_likes, 0)),
          greatest(0, coalesce(p_comments, 0)), greatest(0, coalesce(p_shares, 0)),
          case when p_source in ('vk','manual','demo') then p_source else 'manual' end);

  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Сообщества, расписания, правила, персонажи
-- ---------------------------------------------------------------------------
create or replace function public.update_community(p_community_id text, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid;
  v_slots jsonb;
begin
  v_uid := app.assert_owner();
  if not exists (select 1 from public.communities where id = p_community_id) then
    raise exception 'Сообщество не найдено' using errcode = 'P0002';
  end if;

  if p_patch ? 'schedule' then
    v_slots := p_patch -> 'schedule';
    if jsonb_typeof(v_slots) <> 'array' then
      raise exception 'Расписание должно быть массивом ЧЧ:ММ' using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_array_elements_text(v_slots) s
       where s !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    ) then
      raise exception 'Слоты должны быть в формате ЧЧ:ММ (00:00–23:59)' using errcode = '22023';
    end if;

    insert into public.schedules (community_id, slots)
    values (p_community_id, v_slots)
    on conflict (community_id) do update set slots = excluded.slots;
  end if;

  if p_patch ? 'paused' then
    insert into public.schedules (community_id, paused)
    values (p_community_id, (p_patch ->> 'paused')::boolean)
    on conflict (community_id) do update set paused = excluded.paused;
  end if;

  if p_patch ? 'skipUntil' then
    insert into public.schedules (community_id, skip_until)
    values (p_community_id, nullif(p_patch ->> 'skipUntil', '')::date)
    on conflict (community_id) do update set skip_until = excluded.skip_until;
  end if;

  if p_patch ? 'vkGroupId' then
    update public.communities set vk_group_id = nullif(p_patch ->> 'vkGroupId', ''),
           vk_connected = (coalesce(nullif(p_patch ->> 'vkGroupId', ''), '') <> ''
                           and exists (select 1 from public.community_secrets cs
                                        where cs.community_id = p_community_id))
     where id = p_community_id;
  end if;

  if p_patch ? 'vkScreenName' then
    update public.communities set vk_screen_name = nullif(p_patch ->> 'vkScreenName', '')
     where id = p_community_id;
  end if;

  if p_patch ? 'styleRules' then
    update public.communities set style_rules = p_patch -> 'styleRules' where id = p_community_id;
  end if;

  if p_patch ? 'generationSettings' then
    update public.communities set generation_settings = p_patch -> 'generationSettings' where id = p_community_id;
  end if;

  if p_patch ? 'status' then
    if (p_patch ->> 'status') not in ('active', 'paused') then
      raise exception 'Недопустимый статус сообщества' using errcode = '22023';
    end if;
    update public.communities set status = p_patch ->> 'status' where id = p_community_id;
  end if;

  perform app.log_audit('community_update', 'community', p_community_id,
    jsonb_build_object('keys', (select jsonb_agg(k) from jsonb_object_keys(p_patch) k)));
  return (select to_jsonb(c) from public.communities c where c.id = p_community_id);
end;
$$;

create or replace function public.save_community_rules(
  p_community_id text, p_rules jsonb, p_change_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid;
  v_version int;
  v_current jsonb;
begin
  v_uid := app.assert_owner();

  select coalesce(max(version), 0) + 1 into v_version
    from public.community_rule_versions where community_id = p_community_id;

  select to_jsonb(r) into v_current from public.community_rules r where r.community_id = p_community_id;
  if v_current is not null then
    insert into public.community_rule_versions (community_id, version, rules, change_note, created_by)
    values (p_community_id, v_version - 1, v_current, 'снимок до изменения: ' || coalesce(p_change_note, ''), v_uid)
    on conflict (community_id, version) do nothing;
    v_version := coalesce((select max(version) from public.community_rule_versions where community_id = p_community_id), 0) + 1;
  end if;

  insert into public.community_rules as cr (
    community_id, version, theme, text_style, audience, forbidden, preferred_topics,
    unwanted_topics, successful_examples, image_rules, character_rules, analytics_notes, sources, updated_by
  ) values (
    p_community_id, v_version,
    coalesce(p_rules ->> 'theme', ''),
    coalesce(p_rules ->> 'textStyle', ''),
    coalesce(p_rules ->> 'audience', ''),
    coalesce(array(select jsonb_array_elements_text(p_rules -> 'forbidden')), '{}'),
    coalesce(array(select jsonb_array_elements_text(p_rules -> 'preferredTopics')), '{}'),
    coalesce(array(select jsonb_array_elements_text(p_rules -> 'unwantedTopics')), '{}'),
    coalesce(array(select jsonb_array_elements_text(p_rules -> 'successfulExamples')), '{}'),
    coalesce(p_rules ->> 'imageRules', ''),
    coalesce(p_rules ->> 'characterRules', ''),
    coalesce(p_rules ->> 'analyticsNotes', ''),
    coalesce(array(select jsonb_array_elements_text(p_rules -> 'sources')), '{}'),
    v_uid
  )
  on conflict (community_id) do update set
    version = excluded.version,
    theme = excluded.theme,
    text_style = excluded.text_style,
    audience = excluded.audience,
    forbidden = excluded.forbidden,
    preferred_topics = excluded.preferred_topics,
    unwanted_topics = excluded.unwanted_topics,
    successful_examples = excluded.successful_examples,
    image_rules = excluded.image_rules,
    character_rules = excluded.character_rules,
    analytics_notes = excluded.analytics_notes,
    sources = excluded.sources,
    updated_by = excluded.updated_by,
    updated_at = now();

  insert into public.community_rule_versions (community_id, version, rules, change_note, created_by)
  select p_community_id, cr.version, to_jsonb(cr), coalesce(p_change_note, ''), v_uid
    from public.community_rules cr where cr.community_id = p_community_id;

  perform app.log_audit('community_rules_update', 'community', p_community_id,
    jsonb_build_object('version', v_version, 'note', p_change_note));

  return jsonb_build_object('version', v_version);
end;
$$;

create or replace function public.save_character(p_character_id text, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid;
  v_char public.characters;
  v_appearance_changed boolean := false;
begin
  v_uid := app.assert_owner();

  select * into v_char from public.characters where id = p_character_id for update;
  if v_char is null then
    raise exception 'Персонаж не найден' using errcode = 'P0002';
  end if;

  if p_patch ? 'appearance' then
    if v_char.locked and (p_patch ->> 'unlockConfirmed')::boolean is not true then
      raise exception 'Внешность заблокирована. Снимите замок явным подтверждением, чтобы изменить.'
        using errcode = '42501';
    end if;
    v_appearance_changed := (p_patch -> 'appearance') is distinct from v_char.appearance;
  end if;

  update public.characters
     set description = coalesce(p_patch ->> 'description', description),
         personality = coalesce(p_patch ->> 'personality', personality),
         role = coalesce(p_patch ->> 'role', role),
         name = coalesce(p_patch ->> 'name', name),
         appearance = coalesce(p_patch -> 'appearance', appearance),
         locked = coalesce((p_patch ->> 'locked')::boolean, locked),
         appearance_status = case
           when v_appearance_changed then 'placeholder'
           else coalesce(p_patch ->> 'appearanceStatus', appearance_status) end
   where id = p_character_id
   returning * into v_char;

  if v_appearance_changed then
    -- Изменение описания внешности обнуляет подтверждение: нужны новые референсы от владельца.
    update public.character_references set approved = false, is_primary = false
     where character_id = p_character_id;
    update public.characters set primary_reference_id = null, appearance_status = 'placeholder'
     where id = p_character_id;
    perform app.notify('system', 'Внешность персонажа изменена',
      'Подтверждение референсов сброшено. Загрузите и подтвердите эталонное изображение заново.',
      '/characters');
  end if;

  perform app.log_audit('character_update', 'character', p_character_id,
    jsonb_build_object('appearanceChanged', v_appearance_changed));

  return (select to_jsonb(c) from public.characters c where c.id = p_character_id);
end;
$$;

create or replace function public.add_character_reference(
  p_character_id text,
  p_storage_path text,
  p_notes text default '',
  p_make_primary boolean default false,
  p_approved boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid;
  v_ref public.character_references;
begin
  v_uid := app.assert_owner();
  if not exists (select 1 from public.characters where id = p_character_id) then
    raise exception 'Персонаж не найден' using errcode = 'P0002';
  end if;
  if coalesce(p_storage_path, '') = '' then
    raise exception 'Пустой путь к файлу референса' using errcode = '22023';
  end if;

  insert into public.character_references (character_id, storage_path, notes, is_primary, approved, created_by)
  values (p_character_id, p_storage_path, coalesce(p_notes, ''), false, p_approved, v_uid)
  returning * into v_ref;

  if p_make_primary then
    perform public.set_primary_reference(v_ref.id);
  end if;

  perform app.log_audit('character_reference_add', 'character', p_character_id,
    jsonb_build_object('reference', v_ref.id, 'approved', p_approved));

  return to_jsonb(v_ref);
end;
$$;

create or replace function public.set_primary_reference(p_reference_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid;
  v_ref public.character_references;
begin
  v_uid := app.assert_owner();

  select * into v_ref from public.character_references where id = p_reference_id for update;
  if v_ref is null then
    raise exception 'Референс не найден' using errcode = 'P0002';
  end if;
  if v_ref.approved is not true then
    raise exception 'Основным можно сделать только подтверждённый референс' using errcode = '23514';
  end if;

  update public.character_references set is_primary = false where character_id = v_ref.character_id;

  update public.character_references set is_primary = true, approved = true where id = p_reference_id;

  update public.characters
     set primary_reference_id = p_reference_id,
         appearance_status = 'approved'
   where id = v_ref.character_id;

  perform app.log_audit('character_reference_primary', 'character', v_ref.character_id,
    jsonb_build_object('reference', p_reference_id));
  return jsonb_build_object('ok', true, 'characterId', v_ref.character_id);
end;
$$;

create or replace function public.approve_character_reference(p_reference_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid;
  v_ref public.character_references;
begin
  v_uid := app.assert_owner();
  update public.character_references set approved = true
   where id = p_reference_id
   returning * into v_ref;
  if v_ref is null then
    raise exception 'Референс не найден' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.character_references
    where character_id = v_ref.character_id and is_primary
  ) then
    perform public.set_primary_reference(v_ref.id);
  else
    update public.characters set appearance_status = 'approved' where id = v_ref.character_id;
  end if;

  perform app.log_audit('character_reference_approve', 'character', v_ref.character_id,
    jsonb_build_object('reference', p_reference_id));
  return to_jsonb(v_ref);
end;
$$;

create or replace function public.delete_character_reference(p_reference_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid;
  v_ref public.character_references;
  v_used int;
begin
  v_uid := app.assert_owner();
  select * into v_ref from public.character_references where id = p_reference_id for update;
  if v_ref is null then
    raise exception 'Референс не найден' using errcode = 'P0002';
  end if;

  -- Не удаляем файл, если он участвует в одобренной или запланированной публикации.
  select count(*) into v_used
    from public.posts p
    join public.media_assets m on m.path = v_ref.storage_path
   where m.post_id = p.id and p.status in ('approved','scheduled','published');
  if v_used > 0 then
    raise exception 'Нельзя удалить изображение, используемое одобренной или запланированной публикацией'
      using errcode = '23503';
  end if;

  update public.characters
     set primary_reference_id = null,
         appearance_status = case when appearance_status = 'approved' then 'placeholder' else appearance_status end
   where id = v_ref.character_id and primary_reference_id = p_reference_id;

  delete from public.character_references where id = p_reference_id;

  perform app.log_audit('character_reference_delete', 'character', v_ref.character_id,
    jsonb_build_object('reference', p_reference_id));
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Настройки, интеграции, уведомления, аналитика, дашборд
-- ---------------------------------------------------------------------------
create or replace function public.save_settings(p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid;
begin
  v_uid := app.assert_owner();

  if p_patch ? 'mode' then
    if (p_patch ->> 'mode') not in ('test', 'approval') then
      raise exception 'Недопустимый режим' using errcode = '22023';
    end if;
    perform app.set_setting('app_mode', p_patch ->> 'mode');
  end if;

  if p_patch ? 'realPublishEnabled' then
    perform app.set_setting('real_publish_enabled', (p_patch ->> 'realPublishEnabled')::boolean::text);
  end if;

  if p_patch ? 'automationPaused' then
    perform app.set_setting('automation_paused', (p_patch ->> 'automationPaused')::boolean::text);
  end if;

  if p_patch ? 'prepareHoursAhead' then
    perform app.set_setting('prepare_hours_ahead',
      greatest(1, least(720, (p_patch ->> 'prepareHoursAhead')::int))::text);
  end if;

  if p_patch ? 'aiMonthlyLimitUsd' then
    perform app.set_setting('ai_monthly_limit_usd',
      greatest(0, (p_patch ->> 'aiMonthlyLimitUsd')::numeric)::text);
  end if;

  if p_patch ? 'notificationsEnabled' then
    perform app.set_setting('notifications_enabled', (p_patch ->> 'notificationsEnabled')::boolean::text);
  end if;

  if p_patch ? 'aiProvider' then
    perform app.set_setting('ai_provider',
      case when (p_patch ->> 'aiProvider') in ('test','openai','compatible','custom')
           then p_patch ->> 'aiProvider' else 'test' end);
  end if;

  if p_patch ? 'aiTextModel' then
    perform app.set_setting('ai_text_model', left(coalesce(p_patch ->> 'aiTextModel', ''), 120));
  end if;

  if p_patch ? 'aiImageModel' then
    perform app.set_setting('ai_image_model', left(coalesce(p_patch ->> 'aiImageModel', ''), 120));
  end if;

  if p_patch ? 'aiBaseUrl' then
    perform app.set_setting('ai_base_url', left(coalesce(p_patch ->> 'aiBaseUrl', ''), 240));
  end if;

  perform app.log_audit('settings_update', 'application_settings', null,
    jsonb_build_object('keys', (select jsonb_agg(k) from jsonb_object_keys(p_patch) k)));

  return public.get_settings();
end;
$$;

create or replace function public.get_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
begin
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

create or replace function public.month_spend_usd()
returns numeric
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select coalesce(sum(cost_usd), 0)::numeric(12,4)
    from public.ai_generations
   where created_at >= date_trunc('month', now() at time zone 'UTC');
$$;

create or replace function public.set_integration_status(
  p_key text, p_status text, p_detail text default '', p_configured boolean default null, p_verified boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  insert into public.integration_status as i (key, label, configured, verified, status, detail, checked_at)
  values (
    p_key,
    coalesce((select label from public.integration_status where key = p_key), p_key),
    coalesce(p_configured, p_status in ('configured','verified')),
    coalesce(p_verified, p_status = 'verified'),
    case when p_status in ('off','configured','verified','error','demo') then p_status else 'off' end,
    coalesce(p_detail, ''),
    now()
  )
  on conflict (key) do update set
    configured = coalesce(p_configured, excluded.configured),
    verified = coalesce(p_verified, excluded.verified),
    status = excluded.status,
    detail = excluded.detail,
    checked_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.mark_notifications_read(p_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  perform app.assert_owner();
  if p_id is null then
    update public.notifications set read = true where read = false;
  else
    update public.notifications set read = true where id = p_id;
  end if;
  return jsonb_build_object('unread', (select count(*) from public.notifications where read = false));
end;
$$;

create or replace function public.import_analytics(p_rows jsonb, p_note text default '')
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid;
  v_count int := 0;
  r record;
begin
  v_uid := app.assert_owner();

  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    if coalesce(r.value ->> 'postId', '') <> '' then
      insert into public.post_statistics (post_id, community_id, views, likes, comments, shares, source)
      select r.value ->> 'postId', p.community_id,
             greatest(0, coalesce((r.value ->> 'views')::int, 0)),
             greatest(0, coalesce((r.value ->> 'likes')::int, 0)),
             greatest(0, coalesce((r.value ->> 'comments')::int, 0)),
             greatest(0, coalesce((r.value ->> 'shares')::int, 0)),
             'manual'
        from public.posts p where p.id = r.value ->> 'postId';
      v_count := v_count + 1;
    end if;

    if coalesce(r.value ->> 'communityId', '') <> '' and coalesce(r.value ->> 'date', '') <> '' then
      insert into public.analytics_snapshots (community_id, period_start, period_end, totals, note)
      values (
        r.value ->> 'communityId',
        (r.value ->> 'date')::date,
        (r.value ->> 'date')::date,
        jsonb_build_object(
          'views', greatest(0, coalesce((r.value ->> 'views')::int, 0)),
          'likes', greatest(0, coalesce((r.value ->> 'likes')::int, 0)),
          'comments', greatest(0, coalesce((r.value ->> 'comments')::int, 0)),
          'shares', greatest(0, coalesce((r.value ->> 'shares')::int, 0))
        ),
        coalesce(p_note, 'импорт владельца')
      );
      v_count := v_count + 1;
    end if;
  end loop;

  perform app.set_setting('analytics_import_last_at', now()::text);
  perform app.log_audit('analytics_import', 'analytics', null,
    jsonb_build_object('rows', v_count, 'note', p_note));
  return jsonb_build_object('imported', v_count);
end;
$$;

create or replace function public.missed_slots(p_lookback_days int default 2)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select coalesce(jsonb_agg(x order by x.scheduled_at), '[]'::jsonb) from (
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
$$;

create or replace function public.analytics_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_published int;
  v_points jsonb;
  v_best jsonb;
begin
  perform app.assert_owner();

  select count(*) into v_published from public.posts where status = 'published';

  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_points from (
    select s.collected_at::date as date,
           s.community_id,
           sum(s.views)::int as views,
           sum(s.likes)::int as likes,
           sum(s.comments)::int as comments,
           sum(s.shares)::int as shares,
           max(s.source) as source
      from public.post_statistics s
     group by 1, 2
     order by 1 asc
     limit 400
  ) x;

  select coalesce(jsonb_agg(y), '[]'::jsonb) into v_best from (
    select p.id as post_id,
           coalesce(nullif(p.title, ''), p.topic) as title,
           p.community_id,
           (coalesce(s.views,0) + 3*coalesce(s.likes,0) + 5*coalesce(s.comments,0) + 4*coalesce(s.shares,0))::int as score,
           coalesce(s.views,0) as views
      from public.posts p
      left join (
        select post_id, sum(views) as views, sum(likes) as likes, sum(comments) as comments, sum(shares) as shares
          from public.post_statistics group by post_id
      ) s on s.post_id = p.id
     where p.status = 'published'
     order by score desc nulls last
     limit 10
  ) y;

  return jsonb_build_object(
    'points', v_points,
    'best', v_best,
    'publishedCount', v_published,
    'insufficientData', v_published < 12,
    'thresholds', jsonb_build_object('postsForConclusions', 12),
    'note', case
      when app.get_setting('app_mode', 'test') = 'test'
        then 'Тестовый режим: живой сбор статистики VK не выполняется. Показаны только сохранённые факты.'
      else 'Данные из VK или импорта владельца. Пустые значения — отсутствие данных, а не ноль.'
    end
  );
end;
$$;

-- Сводка для главной панели одним запросом (включая честный статус интеграций).
create or replace function public.dashboard_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_result jsonb;
begin
  perform app.assert_owner();

  select jsonb_build_object(
    'counts', coalesce((
      select jsonb_object_agg(status, c) from (
        select status, count(*)::int as c from public.posts group by status
      ) s
    ), '{}'::jsonb),
    'byCommunity', coalesce((
      select jsonb_agg(x) from (
        select c.id,
               c.name,
               c.color,
               count(*) filter (where p.status in ('review','needs_revision'))::int as pending,
               count(*) filter (where p.status in ('scheduled','approved'))::int as scheduled,
               count(*) filter (where p.status = 'published')::int as published,
               count(*) filter (where p.status = 'error')::int as errors
          from public.communities c
          left join public.posts p on p.community_id = c.id
         group by c.id, c.name, c.color
         order by c.name
      ) y
    ), '[]'::jsonb),
    'nextPosts', coalesce((
      select jsonb_agg(z) from (
        select to_jsonb(p) as post from public.posts p
         where p.scheduled_at >= now()
         order by p.scheduled_at asc limit 8
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
          ) alljobs
         order by created_at desc limit 20
      ) j
    ), '[]'::jsonb),
    'missedSlots', jsonb_array_length(public.missed_slots(2)),
    'spendUsdMonth', public.month_spend_usd(),
    'unreadNotifications', (select count(*) from public.notifications where read = false),
    'integrations', coalesce((select jsonb_agg(to_jsonb(i)) from public.integration_status i), '[]'::jsonb),
    'settings', public.get_settings()
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Права на функции
-- ---------------------------------------------------------------------------
do $$
declare
  fn text;
  user_fns text[] := array[
    'public.create_manual_post(text,timestamptz,text,text)',
    'public.save_post_edit(text,text,text,timestamptz,text,text)',
    'public.approve_post(text,text)',
    'public.reject_post(text,text)',
    'public.request_revision(text,text,text)',
    'public.schedule_post(text)',
    'public.unschedule_post(text,text)',
    'public.enqueue_generation(text,timestamptz,text,boolean,text)',
    'public.enqueue_upcoming_generations(integer)',
    'public.enqueue_regeneration(text,text)',
    'public.update_community(text,jsonb)',
    'public.save_community_rules(text,jsonb,text)',
    'public.save_character(text,jsonb)',
    'public.add_character_reference(text,text,text,boolean,boolean)',
    'public.set_primary_reference(uuid)',
    'public.approve_character_reference(uuid)',
    'public.delete_character_reference(uuid)',
    'public.save_settings(jsonb)',
    'public.get_settings()',
    'public.month_spend_usd()',
    'public.mark_notifications_read(uuid)',
    'public.import_analytics(jsonb,text)',
    'public.missed_slots(integer)',
    'public.analytics_overview()',
    'public.dashboard_overview()'
  ];
  service_fns text[] := array[
    'public.claim_generation_job(text[],text)',
    'public.finish_generation_job(uuid,boolean,jsonb,text,numeric,text,text)',
    'public.requeue_stale_jobs(integer)',
    'public.claim_publication_job(text)',
    'public.finish_publication_job(uuid,boolean,text,text,integer)',
    'public.posts_due_for_publication(integer)',
    'public.mark_post_published(text,text,timestamptz)',
    'public.posts_due_for_stats(integer)',
    'public.save_post_statistics(text,integer,integer,integer,integer,text)',
    'public.set_integration_status(text,text,text,boolean,boolean)'
  ];
begin
  foreach fn in array user_fns loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;

  foreach fn in array service_fns loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
