-- =============================================================================
-- Safe VK publication lifecycle.
-- Applied after the original schema/RPC migrations; intentionally additive.
-- No VK API calls are made by this migration.
-- =============================================================================

alter table public.publication_jobs
  add column if not exists dispatch_started_at timestamptz,
  add column if not exists target_group_id text,
  add column if not exists remote_cancel_state text not null default 'none',
  add column if not exists remote_cancel_error text,
  add column if not exists remote_cancelled_at timestamptz;

alter table public.publication_jobs
  drop constraint if exists publication_jobs_status_check;
alter table public.publication_jobs
  add constraint publication_jobs_status_check
  check (status in ('queued','running','done','failed','cancelled','skipped','unknown'));

alter table public.publication_jobs
  drop constraint if exists publication_jobs_remote_cancel_state_check;
alter table public.publication_jobs
  add constraint publication_jobs_remote_cancel_state_check
  check (remote_cancel_state in ('none','pending','confirmed','failed','unknown'));

-- Legacy attempts pre-date the dispatch fence and did not reliably distinguish
-- a definite rejection from a lost wall.post response. Preserve historical
-- target groups only for never-attempted jobs; never guess where an old VK ID lives.
update public.publication_jobs j
   set target_group_id = c.vk_group_id
  from public.communities c
 where c.id = j.community_id
   and j.target_group_id is null
   and j.attempts = 0
   and j.vk_post_id is null
   and j.status <> 'running';

-- Do not silently retry any legacy real attempt without a saved remote ID.
update public.publication_jobs j
   set status = 'unknown',
       dispatch_started_at = coalesce(j.dispatch_started_at, j.updated_at, now()),
       locked_at = null,
       locked_by = null,
       last_error = 'Попытка до установки предохранителя: результат wall.post неизвестен; проверьте VK вручную.'
 where not j.dry_run
   and j.attempts > 0
   and j.vk_post_id is null
   and j.status in ('queued','running','done','failed','cancelled')
   and not exists (
     select 1 from public.posts p where p.id = j.post_id
       and p.vk_post_id is not null and left(p.vk_post_id, 5) <> 'test_'
   );

update public.posts p
   set error_message = 'Неизвестен результат предыдущей попытки VK. Автоматический повтор запрещён; проверьте VK вручную.'
 where exists (
   select 1 from public.publication_jobs j
    where j.post_id = p.id and j.status = 'unknown'
      and j.last_error like 'Попытка до установки предохранителя:%'
 );

create index if not exists idx_publication_jobs_unknown
  on public.publication_jobs(status, dispatch_started_at)
  where status in ('running','unknown');

-- A VK Group ID is part of the effective publication target. Snapshot it per job.
create or replace function app.publication_jobs_capture_group()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  if new.target_group_id is null then
    select c.vk_group_id into new.target_group_id
      from public.communities c where c.id = new.community_id;
  end if;
  return new;
end;
$$;

drop trigger if exists publication_jobs_capture_group on public.publication_jobs;
create trigger publication_jobs_capture_group
  before insert on public.publication_jobs
  for each row execute function app.publication_jobs_capture_group();

-- Once VK may have accepted a post, edits cannot discard that remote identity or
-- make a stale local version look safe. An explicit remote cancellation is required.
create or replace function app.posts_sync_hash()
returns trigger
language plpgsql
as $$
declare
  v_hash text;
begin
  new.text := coalesce(new.text, '');
  v_hash := app.content_hash(new.community_id, new.text, new.image_path, new.scheduled_at);

  if tg_op = 'INSERT' then
    new.content_hash := v_hash;
    if new.approved_hash is not null and new.approved_hash <> v_hash then
      raise exception 'Одобрение не соответствует содержимому публикации' using errcode = '23514';
    end if;
    return new;
  end if;

  if v_hash is distinct from old.content_hash and exists (
    select 1
      from public.publication_jobs j
     where j.post_id = old.id
       and j.remote_cancel_state <> 'confirmed'
       and (
         (j.vk_post_id is not null and left(j.vk_post_id, 5) <> 'test_')
         or (j.dispatch_started_at is not null and j.status in ('running','unknown'))
       )
  ) then
    raise exception 'В VK уже может существовать отложенная публикация. Сначала подтвердите удаление в VK.'
      using errcode = '23514';
  end if;

  if v_hash is distinct from old.content_hash then
    new.content_hash := v_hash;
    -- Material edits invalidate approval; this canonical hash covers text,
    -- image path, schedule and community. Never clear a live VK id silently.
    if old.approved_hash is not null or old.status in ('approved', 'scheduled') then
      new.approved_hash := null;
      new.approved_at := null;
      new.approved_by := null;
      if old.status in ('approved', 'scheduled') then
        new.status := 'review';
        new.vk_post_id := null;
        new.test_mode := true;
      end if;
    end if;
  end if;

  if new.approved_hash is not null and new.approved_hash <> new.content_hash then
    raise exception 'Одобрение не соответствует содержимому публикации' using errcode = '23514';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- Do not redirect a community while VK has a known or ambiguous outstanding post.
-- Local queued jobs are cancelled and all affected approvals are invalidated.
create or replace function app.guard_community_vk_target_change()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  if new.vk_group_id is not distinct from old.vk_group_id then
    return new;
  end if;

  -- Match claim/cancel lock order to avoid a post↔job deadlock. Lock posts first,
  -- then re-check active jobs on a fresh statement snapshot after any worker wait.
  perform 1 from public.posts p
   where p.community_id = old.id and p.status in ('approved','scheduled')
   for update;

  if exists (
    select 1 from public.publication_jobs j
     where j.community_id = old.id
       and j.remote_cancel_state <> 'confirmed'
       and (
         (j.vk_post_id is not null and left(j.vk_post_id, 5) <> 'test_')
         or (j.dispatch_started_at is not null and j.status in ('running','unknown'))
       )
  ) then
    raise exception 'Нельзя менять VK Group ID: есть публикации, которые могут оставаться в VK. Сначала подтвердите отмену.'
      using errcode = '23514';
  end if;

  update public.publication_jobs
     set status = 'cancelled',
         last_error = 'VK Group ID сообщества изменён до отправки'
   where community_id = old.id
     and status in ('queued','running')
     and dispatch_started_at is null
     and vk_post_id is null;

  update public.posts p
     set approved_hash = null,
         approved_at = null,
         approved_by = null,
         status = case when p.status in ('approved','scheduled') then 'review' else p.status end,
         test_mode = true,
         vk_post_id = case when left(p.vk_post_id, 5) = 'test_' then null else p.vk_post_id end,
         error_message = 'VK-сообщество изменено. Проверьте публикацию и одобрите текущую версию заново.'
   where p.community_id = old.id
     and p.status in ('approved','scheduled');

  return new;
end;
$$;

drop trigger if exists communities_vk_target_guard on public.communities;
create trigger communities_vk_target_guard
  before update of vk_group_id on public.communities
  for each row execute function app.guard_community_vk_target_change();

-- Replacing the old routine closes a gap where an unknown outcome could be
-- rescheduled by an idempotency-key conflict as if nothing had been sent.
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
  if v_post.approved_hash is null or v_post.approved_hash <> v_post.content_hash then
    raise exception 'Публикация без актуального одобрения невозможна' using errcode = '42501';
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
  if v_job is not null and v_job.status in ('running', 'queued', 'unknown') then
    raise exception 'Эта версия уже отправляется или имеет неизвестный результат. Повтор запрещён.'
      using errcode = '23505';
  end if;
  if v_job is not null and v_job.vk_post_id is not null
     and left(v_job.vk_post_id, 5) <> 'test_' and v_job.remote_cancel_state <> 'confirmed' then
    raise exception 'У этой версии есть сохранённый VK post ID. Сначала подтвердите отмену во ВКонтакте.'
      using errcode = '23505';
  end if;
  if v_job is not null and v_job.remote_cancel_state in ('pending','failed','unknown') then
    raise exception 'Удаление публикации в VK не подтверждено. Сначала проверьте её статус во ВКонтакте.'
      using errcode = '23505';
  end if;

  insert into public.publication_jobs (
    post_id, community_id, version_hash, scheduled_at, dry_run, idempotency_key
  ) values (
    v_post.id, v_post.community_id, v_post.approved_hash, v_post.scheduled_at, v_dry_run, v_key
  )
  on conflict (idempotency_key) do update
    set status = 'queued', run_at = now(), last_error = null,
        attempts = 0, dry_run = excluded.dry_run,
        vk_post_id = case
          when publication_jobs.remote_cancel_state = 'confirmed'
            or left(publication_jobs.vk_post_id, 5) = 'test_' then null
          else publication_jobs.vk_post_id
        end,
        dispatch_started_at = null, locked_at = null, locked_by = null,
        target_group_id = excluded.target_group_id,
        remote_cancel_state = 'none', remote_cancel_error = null,
        remote_cancelled_at = null
  returning * into v_job;

  update public.posts
     set status = 'scheduled', test_mode = v_dry_run,
         vk_post_id = case when left(vk_post_id, 5) = 'test_' then null else vk_post_id end,
         error_message = null
   where id = p_post_id;

  perform app.log_audit('schedule', 'post', p_post_id,
    jsonb_build_object('job', v_job.id, 'dryRun', v_dry_run, 'hash', v_post.approved_hash));
  perform app.notify(
    'scheduled',
    case when v_dry_run then 'Пост запланирован (dry-run)' else 'Пост передан в очередь VK' end,
    coalesce(nullif(v_post.title, ''), v_post.topic),
    '/posts/' || p_post_id
  );

  return jsonb_build_object('post', app.post_json(p_post_id), 'jobId', v_job.id, 'dryRun', v_dry_run);
end;
$$;

-- Claim with a stable lock order (post first, queue row second), validate the
-- approved snapshot, and refuse jobs that already carry a VK id/dispatch fence.
create or replace function public.claim_publication_job(p_worker text default 'worker')
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_candidate uuid;
  v_job public.publication_jobs;
  v_post public.posts;
  v_group text;
begin
  select j.id into v_candidate
    from public.publication_jobs j
   where j.status = 'queued' and j.run_at <= now()
   order by j.run_at asc
   limit 1;
  if v_candidate is null then return null; end if;

  select p.* into v_post
    from public.posts p
    join public.publication_jobs j on j.post_id = p.id
   where j.id = v_candidate
   for update of p skip locked;
  if v_post is null then return null; end if;

  select * into v_job from public.publication_jobs
   where id = v_candidate and status = 'queued'
   for update skip locked;
  if v_job is null then return null; end if;

  if v_job.vk_post_id is not null or (v_post.vk_post_id is not null and left(v_post.vk_post_id, 5) <> 'test_') then
    if v_job.vk_post_id is not null and v_post.vk_post_id is not null
       and v_job.vk_post_id <> v_post.vk_post_id then
      update public.publication_jobs set status = 'unknown',
        last_error = 'В БД найдены разные VK post ID; автоматический повтор запрещён'
       where id = v_job.id;
      update public.posts set error_message = 'Неопределённый результат VK: найдены разные post ID. Проверьте сообщество вручную.'
       where id = v_post.id;
      return jsonb_build_object('cancelled', true, 'jobId', v_job.id, 'unknown', true);
    end if;

    update public.publication_jobs
       set status = 'done', vk_post_id = coalesce(v_job.vk_post_id, v_post.vk_post_id),
           last_error = null, locked_at = null, locked_by = null
     where id = v_job.id;
    update public.posts set vk_post_id = coalesce(v_job.vk_post_id, v_post.vk_post_id)
     where id = v_post.id;
    return jsonb_build_object('alreadyPosted', true, 'jobId', v_job.id,
      'vkPostId', coalesce(v_job.vk_post_id, v_post.vk_post_id));
  end if;

  select c.vk_group_id into v_group from public.communities c where c.id = v_post.community_id;
  if v_post.approved_hash is null
     or v_post.approved_hash <> v_post.content_hash
     or v_post.approved_hash <> v_job.version_hash
     or v_post.community_id <> v_job.community_id
     or v_post.scheduled_at <> v_job.scheduled_at
     or v_job.target_group_id is distinct from v_group
     or v_post.status <> 'scheduled' then
    update public.publication_jobs set status = 'cancelled',
      last_error = 'Одобрение, время или VK-сообщество не совпадает с сохранённым снимком'
     where id = v_job.id;
    update public.posts set approved_hash = null, approved_at = null, approved_by = null,
      status = case when status in ('approved','scheduled') then 'review' else status end,
      test_mode = true,
      error_message = 'Публикация заблокирована: одобрение или целевое сообщество изменилось. Требуется повторная проверка.'
     where id = v_post.id;
    return jsonb_build_object('cancelled', true, 'jobId', v_job.id);
  end if;

  update public.publication_jobs
     set status = 'running', attempts = attempts + 1, locked_at = now(), locked_by = p_worker,
         dispatch_started_at = null
   where id = v_job.id
   returning * into v_job;

  return jsonb_build_object(
    'id', v_job.id,
    'postId', v_job.post_id,
    'communityId', v_job.community_id,
    'versionHash', v_job.version_hash,
    'scheduledAt', v_job.scheduled_at,
    'targetGroupId', v_job.target_group_id,
    'vkPostId', v_job.vk_post_id,
    'dryRun', v_job.dry_run,
    'attempts', v_job.attempts,
    'maxAttempts', v_job.max_attempts
  );
end;
$$;

-- Final, row-locked approval/settings fence immediately before wall.post.
create or replace function public.begin_publication_dispatch(
  p_job_id uuid,
  p_version_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_post_id text;
  v_community_id text;
  v_job public.publication_jobs;
  v_post public.posts;
  v_group text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Только сервер может начать отправку в VK' using errcode = '42501';
  end if;

  select post_id, community_id into v_post_id, v_community_id
    from public.publication_jobs where id = p_job_id;
  if v_post_id is null then raise exception 'Задание публикации не найдено' using errcode = 'P0002'; end if;

  -- Keep community→post→job lock order shared with community-target changes.
  select c.vk_group_id into v_group from public.communities c
   where c.id = v_community_id for share;
  select * into v_post from public.posts where id = v_post_id for update;
  select * into v_job from public.publication_jobs where id = p_job_id for update;
  if v_job is null or v_post is null then raise exception 'Задание или публикация не найдены' using errcode = 'P0002'; end if;
  if v_job.status <> 'running' or v_job.dispatch_started_at is not null then
    raise exception 'Задание не находится в безопасном состоянии отправки' using errcode = '23514';
  end if;
  if v_job.vk_post_id is not null or (v_post.vk_post_id is not null and left(v_post.vk_post_id, 5) <> 'test_') then
    raise exception 'VK post ID уже известен; повторная отправка запрещена' using errcode = '23505';
  end if;
  if v_post.status <> 'scheduled'
     or v_post.approved_hash is null
     or v_post.approved_hash <> v_post.content_hash
     or v_post.approved_hash <> p_version_hash
     or v_job.version_hash <> p_version_hash
     or v_post.community_id <> v_job.community_id
     or v_post.scheduled_at <> v_job.scheduled_at then
    update public.publication_jobs set status = 'cancelled',
      last_error = 'Одобренная версия изменилась до отправки'
     where id = v_job.id;
    update public.posts set status = 'review', approved_hash = null, approved_at = null,
      approved_by = null, test_mode = true,
      error_message = 'Публикация заблокирована: версия изменилась до отправки. Требуется повторное одобрение.'
     where id = v_post.id;
    return jsonb_build_object('cancelled', true, 'reason', 'approval_stale');
  end if;
  if coalesce(v_post.text, '') = '' or coalesce(v_post.image_path, '') = '' then
    raise exception 'Публикация заблокирована: одобренный текст и изображение обязательны' using errcode = '23514';
  end if;
  if app.get_setting('app_mode', 'test') <> 'approval'
     or not app.get_bool_setting('real_publish_enabled', false)
     or v_job.dry_run
     or v_post.test_mode
     or app.get_bool_setting('automation_paused', false) then
    raise exception 'Реальная публикация сейчас запрещена настройками' using errcode = '42501';
  end if;

  if coalesce(v_group, '') = '' or v_group is distinct from v_job.target_group_id then
    update public.publication_jobs set status = 'cancelled',
      last_error = 'VK Group ID изменился после планирования'
     where id = v_job.id;
    update public.posts set status = 'review', approved_hash = null, approved_at = null,
      approved_by = null, test_mode = true,
      error_message = 'Публикация заблокирована: VK Group ID изменился. Проверьте сообщество и одобрите пост заново.'
     where id = v_post.id;
    return jsonb_build_object('cancelled', true, 'reason', 'vk_group_changed');
  end if;

  -- Never let a delayed queue call become an immediate wall.post ahead of its
  -- approved slot. Reclaim at/after the planned time instead.
  if v_post.scheduled_at > now() and v_post.scheduled_at <= now() + interval '60 seconds' then
    update public.publication_jobs set status = 'queued', run_at = v_post.scheduled_at,
      locked_at = null, locked_by = null, last_error = null
     where id = v_job.id;
    return jsonb_build_object('deferred', true, 'runAt', v_post.scheduled_at);
  end if;

  update public.publication_jobs set dispatch_started_at = now() where id = v_job.id;
  return jsonb_build_object(
    'jobId', v_job.id,
    'postId', v_post.id,
    'communityId', v_post.community_id,
    'versionHash', v_post.approved_hash,
    'scheduledAt', v_post.scheduled_at,
    'groupId', v_group,
    'text', v_post.text,
    'imagePath', v_post.image_path
  );
end;
$$;

-- Resolve one publication attempt. Unknown results and stale dispatches are
-- terminal until a human checks VK; they are never put back in the send queue.
create or replace function public.finish_publication_attempt(
  p_job_id uuid,
  p_outcome text,
  p_vk_post_id text default null,
  p_error text default null,
  p_retry_delay_seconds int default 120,
  p_retryable boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_post_id text;
  v_post public.posts;
  v_job public.publication_jobs;
  v_warning text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Только сервер может завершить задание публикации' using errcode = '42501';
  end if;
  if p_outcome not in ('confirmed','rejected','unknown','preflight_failed','aborted') then
    raise exception 'Недопустимый результат публикации' using errcode = '22023';
  end if;

  select post_id into v_post_id from public.publication_jobs where id = p_job_id;
  if v_post_id is null then raise exception 'Задание публикации не найдено' using errcode = 'P0002'; end if;
  select * into v_post from public.posts where id = v_post_id for update;
  select * into v_job from public.publication_jobs where id = p_job_id for update;
  if v_post is null or v_job is null then raise exception 'Задание или публикация не найдены' using errcode = 'P0002'; end if;

  -- A dry-run result must not resurrect a job the owner cancelled while it was
  -- being processed. Real remote IDs are still persisted below for reconciliation.
  if p_outcome = 'confirmed' and left(coalesce(p_vk_post_id, ''), 5) = 'test_'
     and v_job.status = 'cancelled' then
    return jsonb_build_object('status','cancelled');
  end if;

  -- Idempotent persistence: retrying this DB write cannot repeat wall.post.
  if p_outcome = 'confirmed' then
    if coalesce(p_vk_post_id, '') = '' then
      raise exception 'Подтверждённый результат не содержит VK post ID' using errcode = '22023';
    end if;
    if v_job.vk_post_id is not null and v_job.vk_post_id <> p_vk_post_id then
      update public.publication_jobs set status = 'unknown',
        last_error = 'VK вернул ID, отличный от сохранённого; автоматическая отправка остановлена'
       where id = p_job_id;
      update public.posts set error_message = 'Неопределённый результат VK: получены разные post ID. Проверьте VK вручную.'
       where id = v_post_id;
      return jsonb_build_object('status','unknown');
    end if;

    update public.publication_jobs
       set status = 'done', vk_post_id = p_vk_post_id, last_error = null,
           locked_at = null, locked_by = null
     where id = p_job_id;
    update public.posts
       set vk_post_id = p_vk_post_id,
           status = case when approved_hash = content_hash then 'scheduled' else 'review' end,
           error_message = case
             when v_job.remote_cancel_state in ('unknown','failed','pending') then
               'VK post ID известен (' || p_vk_post_id || '), но отмена не подтверждена. Публикация может остаться в VK; повторите отмену или проверьте вручную.'
             else null end
     where id = v_post_id;
    perform app.log_audit('vk_scheduled', 'post', v_post_id,
      jsonb_build_object('job', p_job_id, 'dryRun', v_job.dry_run, 'vkPostId', p_vk_post_id));
    return jsonb_build_object('status','done','vkPostId',p_vk_post_id);
  end if;

  if v_job.status in ('done','cancelled') then
    return jsonb_build_object('status',v_job.status,'vkPostId',v_job.vk_post_id);
  end if;

  -- If dispatch was fenced but the worker cannot prove a definitive VK error,
  -- convert the result to unknown even if the caller lost the begin-RPC reply.
  if v_job.dispatch_started_at is not null and p_outcome in ('preflight_failed','aborted') then
    p_outcome := 'unknown';
    p_error := coalesce(p_error, 'Результат wall.post неизвестен; автоматический повтор запрещён');
  end if;

  if p_outcome = 'unknown' then
    if v_job.vk_post_id is not null then
      return jsonb_build_object('status','done','vkPostId',v_job.vk_post_id);
    end if;
    v_warning := 'Результат wall.post неизвестен. Не отправляйте повторно: VK мог принять отложенную публикацию. Проверьте VK вручную.';
    update public.publication_jobs
       set status = 'unknown', last_error = coalesce(p_error, v_warning), locked_at = null, locked_by = null
     where id = p_job_id;
    update public.posts set error_message = v_warning where id = v_post_id;
    perform app.notify('publish_error', 'Неизвестен результат публикации VK', v_warning, '/posts/' || v_post_id);
    perform app.log_audit('vk_publish_unknown', 'post', v_post_id,
      jsonb_build_object('job', p_job_id, 'error', p_error));
    return jsonb_build_object('status','unknown','warning',v_warning);
  end if;

  if p_outcome = 'aborted' then
    update public.publication_jobs set status = 'cancelled', last_error = p_error,
      locked_at = null, locked_by = null where id = p_job_id;
    update public.posts set status = case when approved_hash = content_hash then 'approved' else 'review' end,
      test_mode = true, error_message = p_error where id = v_post_id;
    return jsonb_build_object('status','cancelled');
  end if;

  if p_outcome = 'rejected' and p_retryable and v_job.attempts < v_job.max_attempts then
    update public.publication_jobs
       set status = 'queued', run_at = now() + make_interval(secs => greatest(30,p_retry_delay_seconds)),
           last_error = p_error, dispatch_started_at = null, locked_at = null, locked_by = null,
           remote_cancel_state = case when remote_cancel_state in ('unknown','failed','pending') then 'none' else remote_cancel_state end,
           remote_cancel_error = case when remote_cancel_state in ('unknown','failed','pending') then null else remote_cancel_error end
     where id = p_job_id;
    update public.posts set status = 'scheduled', error_message = p_error where id = v_post_id;
    return jsonb_build_object('status','retry');
  end if;

  update public.publication_jobs set status = 'failed', last_error = p_error,
    remote_cancel_state = case when p_outcome = 'rejected' and remote_cancel_state in ('unknown','failed','pending') then 'none' else remote_cancel_state end,
    remote_cancel_error = case when p_outcome = 'rejected' and remote_cancel_state in ('unknown','failed','pending') then null else remote_cancel_error end,
    locked_at = null, locked_by = null where id = p_job_id;
  update public.posts set status = 'error', error_message = coalesce(p_error, 'Публикация не отправлена')
   where id = v_post_id;
  perform app.notify('publish_error', 'Ошибка публикации в VK', coalesce(p_error, 'публикация не отправлена'),
    '/posts/' || v_post_id);
  perform app.log_audit('vk_publish_failed', 'post', v_post_id,
    jsonb_build_object('job', p_job_id, 'error', p_error, 'outcome', p_outcome));
  return jsonb_build_object('status','failed');
end;
$$;

-- Backwards-compatible wrapper for any already-deployed worker. It is
-- deliberately conservative: after dispatch_started_at, a generic failure is
-- unknown, never an automatic retry.
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
  v_started timestamptz;
begin
  select dispatch_started_at into v_started from public.publication_jobs where id = p_job_id;
  if p_ok then
    return public.finish_publication_attempt(p_job_id, 'confirmed', p_vk_post_id, p_error, p_retry_delay_seconds, false);
  end if;
  if v_started is not null then
    return public.finish_publication_attempt(p_job_id, 'unknown', null, p_error, p_retry_delay_seconds, false);
  end if;
  return public.finish_publication_attempt(p_job_id, 'rejected', null, p_error, p_retry_delay_seconds, true);
end;
$$;

-- Begin cancellation. A local queue item is cancelled locally; a known VK id
-- requires a separate, explicit wall.delete call from the Edge Function.
create or replace function public.begin_post_unschedule(p_post_id text, p_reason text default '')
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_uid uuid;
  v_post public.posts;
  v_job public.publication_jobs;
  v_remote_id text;
  v_group text;
  v_warning text;
begin
  v_uid := app.assert_owner();
  select * into v_post from public.posts where id = p_post_id for update;
  if v_post is null then raise exception 'Публикация не найдена' using errcode = 'P0002'; end if;
  if v_post.status = 'published' then
    raise exception 'Опубликованный пост нельзя снять с планирования' using errcode = '23514';
  end if;

  select * into v_job from public.publication_jobs
   where post_id = p_post_id
   order by created_at desc
   limit 1
   for update;

  v_remote_id := case when v_job.vk_post_id is not null and left(v_job.vk_post_id, 5) <> 'test_'
                      then v_job.vk_post_id
                      when v_post.vk_post_id is not null and left(v_post.vk_post_id, 5) <> 'test_'
                      then v_post.vk_post_id else null end;

  if v_job.remote_cancel_state = 'confirmed' then
    update public.posts set status = case when approved_hash = content_hash then 'approved' else 'review' end,
      vk_post_id = null, error_message = null where id = p_post_id;
    return jsonb_build_object('kind','local','status','cancelled','post',app.post_json(p_post_id));
  end if;

  if v_remote_id is null and (
      v_job.status = 'unknown'
      or (v_job.status = 'running' and v_job.dispatch_started_at is not null)
      or (v_job.dispatch_started_at is not null and v_job.status in ('running','unknown'))
  ) then
    v_warning := 'Не удалось определить результат отправки wall.post. Отмена в VK не подтверждена; публикация может остаться. Проверьте VK вручную; повторная отправка запрещена.';
    update public.publication_jobs set status = 'unknown', remote_cancel_state = 'unknown',
      remote_cancel_error = v_warning, last_error = v_warning, locked_at = null, locked_by = null
     where id = v_job.id;
    update public.posts set error_message = v_warning where id = p_post_id;
    perform app.log_audit('vk_cancel_unknown', 'post', p_post_id, jsonb_build_object('job', v_job.id));
    return jsonb_build_object('kind','unknown','status','unknown','warning',v_warning);
  end if;

  if v_remote_id is not null and v_job.id is null then
    v_warning := 'В посте сохранён VK post ID, но соответствующее задание не найдено. Отмена не подтверждена; публикация может остаться в VK. Проверьте вручную.';
    update public.posts set error_message = v_warning where id = p_post_id;
    return jsonb_build_object('kind','unknown','status','unknown','warning',v_warning);
  end if;

  if v_remote_id is not null and v_post.scheduled_at <= now() + interval '60 seconds' then
    v_warning := 'Время публикации уже наступило или наступит в ближайшую минуту. wall.delete не выполнялся: запись могла стать опубликованной. Проверьте VK вручную.';
    update public.publication_jobs set remote_cancel_state = 'unknown', remote_cancel_error = v_warning,
      last_error = v_warning where id = v_job.id;
    update public.posts set error_message = v_warning where id = p_post_id;
    return jsonb_build_object('kind','unknown','status','unknown','warning',v_warning);
  end if;

  if v_remote_id is not null and v_job.target_group_id is null then
    v_warning := 'Для этого старого VK post ID не сохранён снимок целевого сообщества. wall.delete не выполнялся, чтобы не удалить чужую запись; проверьте VK вручную.';
    update public.publication_jobs set remote_cancel_state = 'unknown', remote_cancel_error = v_warning,
      last_error = v_warning where id = v_job.id;
    update public.posts set error_message = v_warning where id = p_post_id;
    perform app.log_audit('vk_cancel_target_unknown', 'post', p_post_id,
      jsonb_build_object('job', v_job.id, 'vkPostId', v_remote_id));
    return jsonb_build_object('kind','unknown','status','unknown','warning',v_warning);
  end if;

  if v_remote_id is not null then
    if v_job.remote_cancel_state = 'pending'
       and v_job.updated_at > now() - interval '90 seconds' then
      v_warning := 'Удаление в VK уже выполняется. Его результат пока неизвестен; публикация может остаться.';
      update public.posts set error_message = v_warning where id = p_post_id;
      return jsonb_build_object('kind','pending','status','pending','warning',v_warning);
    elsif v_job.remote_cancel_state = 'pending' then
      -- This is an explicit owner retry after an abandoned/expired Edge request.
      -- wall.delete is safe to repeat; wall.post is never called here.
      perform app.log_audit('vk_cancel_retry_after_timeout', 'post', p_post_id,
        jsonb_build_object('job', v_job.id, 'vkPostId', v_remote_id));
    end if;
    v_group := v_job.target_group_id;
    update public.publication_jobs set vk_post_id = coalesce(vk_post_id, v_remote_id),
      target_group_id = coalesce(target_group_id, v_group),
      remote_cancel_state = 'pending', remote_cancel_error = null
     where id = v_job.id;
    update public.posts set error_message = 'Запрошено удаление отложенной публикации во ВКонтакте; дождитесь подтверждения.'
     where id = p_post_id;
    perform app.log_audit('vk_cancel_requested', 'post', p_post_id,
      jsonb_build_object('job', v_job.id, 'vkPostId', v_remote_id, 'groupId', v_group));
    return jsonb_build_object('kind','remote','status','pending','jobId',v_job.id,
      'postId',p_post_id,'communityId',v_post.community_id,'vkPostId',v_remote_id,'groupId',v_group);
  end if;

  -- No known remote id and no dispatch fence: the operation is local only.
  if v_job.id is not null and (v_job.status in ('queued','running','failed','cancelled')
      or (v_job.status = 'done' and v_job.dry_run and left(v_job.vk_post_id, 5) = 'test_')) then
    update public.publication_jobs set status = 'cancelled', last_error = coalesce(nullif(p_reason,''),'отменено владельцем'),
      locked_at = null, locked_by = null
     where id = v_job.id and dispatch_started_at is null and vk_post_id is null;
  end if;
  update public.posts set status = case when approved_hash = content_hash and approved_hash is not null then 'approved' else 'review' end,
    vk_post_id = case when left(vk_post_id, 5) = 'test_' then null else vk_post_id end,
    error_message = null
   where id = p_post_id;
  perform app.log_audit('unschedule_local', 'post', p_post_id, jsonb_build_object('reason', p_reason));
  return jsonb_build_object('kind','local','status','cancelled','post',app.post_json(p_post_id));
end;
$$;

create or replace function public.finish_post_unschedule(
  p_job_id uuid,
  p_post_id text,
  p_vk_post_id text,
  p_outcome text,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_post public.posts;
  v_job public.publication_jobs;
  v_warning text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Только сервер может подтвердить отмену VK' using errcode = '42501';
  end if;
  if p_outcome not in ('confirmed','failed','unknown') then
    raise exception 'Недопустимый результат отмены VK' using errcode = '22023';
  end if;
  select * into v_post from public.posts where id = p_post_id for update;
  select * into v_job from public.publication_jobs where id = p_job_id and post_id = p_post_id for update;
  if v_post is null or v_job is null then raise exception 'Публикация или задание не найдены' using errcode = 'P0002'; end if;
  if v_job.vk_post_id is distinct from p_vk_post_id then
    raise exception 'VK post ID не совпадает с заданием' using errcode = '23514';
  end if;
  if v_job.remote_cancel_state = 'confirmed' and v_job.status = 'cancelled' then
    return jsonb_build_object('status','confirmed','post',app.post_json(p_post_id));
  end if;

  if p_outcome = 'confirmed' then
    update public.publication_jobs set status = 'cancelled', remote_cancel_state = 'confirmed',
      remote_cancelled_at = now(), remote_cancel_error = null, last_error = null,
      locked_at = null, locked_by = null where id = p_job_id;
    update public.posts set status = case when approved_hash = content_hash and approved_hash is not null then 'approved' else 'review' end,
      vk_post_id = null, error_message = null where id = p_post_id;
    perform app.log_audit('vk_cancel_confirmed', 'post', p_post_id,
      jsonb_build_object('job', p_job_id, 'vkPostId', p_vk_post_id));
    perform app.notify('scheduled', 'Отмена подтверждена VK',
      'Отложенная публикация удалена из VK.', '/posts/' || p_post_id);
    return jsonb_build_object('status','confirmed','post',app.post_json(p_post_id));
  end if;

  v_warning := case when p_outcome = 'unknown'
    then 'VK не подтвердил результат удаления.' else 'VK отклонил или не подтвердил удаление.' end;
  v_warning := v_warning || ' ' || coalesce(nullif(p_error,''),'') ||
    ' Публикация может остаться запланированной во ВКонтакте. Проверьте VK вручную; автоматический повтор wall.delete не выполняется.';
  update public.publication_jobs set remote_cancel_state = p_outcome,
    remote_cancel_error = v_warning, last_error = v_warning,
    locked_at = null, locked_by = null where id = p_job_id;
  update public.posts set status = case when approved_hash = content_hash then 'scheduled' else status end,
    error_message = v_warning where id = p_post_id;
  perform app.log_audit('vk_cancel_not_confirmed', 'post', p_post_id,
    jsonb_build_object('job', p_job_id, 'vkPostId', p_vk_post_id, 'outcome', p_outcome, 'error', p_error));
  perform app.notify('publish_error', 'Отмена публикации VK не подтверждена', v_warning, '/posts/' || p_post_id);
  return jsonb_build_object('status',p_outcome,'warning',v_warning,'post',app.post_json(p_post_id));
end;
$$;

-- Keep the legacy direct RPC local-only. It cannot claim a remote VK post was cancelled.
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
  if v_post is null then raise exception 'Публикация не найдена' using errcode = 'P0002'; end if;
  if v_post.status = 'published' then
    raise exception 'Опубликованный пост нельзя снять с планирования' using errcode = '23514';
  end if;
  if (v_post.vk_post_id is not null and left(v_post.vk_post_id, 5) <> 'test_')
     or exists (select 1 from public.publication_jobs j where j.post_id = p_post_id
       and j.vk_post_id is not null and left(j.vk_post_id, 5) <> 'test_'
       and j.remote_cancel_state <> 'confirmed') then
    raise exception 'Нужна подтверждённая отмена во ВКонтакте; используйте безопасный маршрут posts/unschedule.'
      using errcode = '23514';
  end if;
  if exists (select 1 from public.publication_jobs j where j.post_id = p_post_id
     and j.dispatch_started_at is not null and j.status in ('running','unknown')) then
    raise exception 'Результат отправки неизвестен. Публикация может остаться в VK; проверьте её вручную.'
      using errcode = '23514';
  end if;
  update public.publication_jobs set status = 'cancelled', last_error = coalesce(p_reason,'отменено владельцем')
   where post_id = p_post_id and status in ('queued','running') and dispatch_started_at is null and vk_post_id is null;
  update public.posts set status = case when approved_hash is not null and approved_hash = content_hash then 'approved' else 'review' end,
    vk_post_id = case when left(vk_post_id, 5) = 'test_' then null else vk_post_id end,
    error_message = null where id = p_post_id;
  perform app.log_audit('unschedule_local', 'post', p_post_id, jsonb_build_object('reason', p_reason));
  return app.post_json(p_post_id);
end;
$$;

-- Stale jobs that never crossed the dispatch fence are safe to retry. Once a
-- dispatch was started, the result is unknown and an operator must reconcile it.
create or replace function public.requeue_stale_jobs(p_stale_seconds int default 600)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_gen int;
  v_pub int := 0;
  v_jobs int;
  v_unknown_posts text[];
begin
  update public.generation_jobs
     set status = 'queued', locked_at = null, locked_by = null, run_at = now(),
         error = coalesce(error, 'восстановление после сбоя воркера')
   where status = 'running' and locked_at < now() - make_interval(secs => p_stale_seconds);
  get diagnostics v_gen = row_count;

  -- Lock posts before job rows, matching claim/cancel/finish lock order.
  with locked_posts as materialized (
    select p.id
      from public.posts p
     where exists (
       select 1 from public.publication_jobs j
        where j.post_id = p.id and j.status = 'running'
          and j.locked_at < now() - make_interval(secs => p_stale_seconds)
          and (j.dispatch_started_at is not null or j.vk_post_id is not null)
     )
     for update of p skip locked
  ), marked as (
    update public.publication_jobs j
       set status = 'unknown', locked_at = null, locked_by = null,
           last_error = 'ответ VK мог быть потерян; автоматический повтор запрещён'
      from locked_posts p
     where j.post_id = p.id and j.status = 'running'
       and j.locked_at < now() - make_interval(secs => p_stale_seconds)
       and (j.dispatch_started_at is not null or j.vk_post_id is not null)
    returning j.post_id
  )
  select coalesce(array_agg(distinct post_id), array[]::text[]) into v_unknown_posts from marked;

  if cardinality(v_unknown_posts) > 0 then
    update public.posts set error_message =
      'Неизвестен результат VK: сервер мог принять отложенную публикацию, но ответ потерян. Автоматический повтор запрещён; проверьте VK вручную.'
     where id = any(v_unknown_posts);
  end if;

  update public.publication_jobs
     set status = 'queued', locked_at = null, locked_by = null, run_at = now(),
         last_error = coalesce(last_error, 'восстановление до отправки после сбоя воркера')
   where status = 'running'
     and locked_at < now() - make_interval(secs => p_stale_seconds)
     and dispatch_started_at is null
     and vk_post_id is null;
  get diagnostics v_pub = row_count;

  update public.jobs
     set status = 'queued', locked_at = null, locked_by = null, run_at = now(),
         error = coalesce(error, 'восстановление после сбоя воркера')
   where status = 'running' and locked_at < now() - make_interval(secs => p_stale_seconds);
  get diagnostics v_jobs = row_count;

  return jsonb_build_object('generation', v_gen, 'publication', v_pub,
    'publicationUnknown', coalesce(cardinality(v_unknown_posts),0), 'jobs', v_jobs);
end;
$$;

-- Due-state reconciliation must not mark a possibly cancelled/unknown VK post as
-- definitely published. Real VK IDs must correspond to a completed queue job.
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
  v_job public.publication_jobs;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Только сервер может сверить статус публикации' using errcode = '42501';
  end if;
  select * into v_post from public.posts where id = p_post_id for update;
  if v_post is null then raise exception 'Публикация не найдена' using errcode = 'P0002'; end if;
  if v_post.approved_hash is null or v_post.approved_hash <> v_post.content_hash then
    raise exception 'Нельзя отметить публикацию как опубликованную без действующего одобрения' using errcode = '42501';
  end if;

  if p_vk_post_id is not null and left(p_vk_post_id, 5) <> 'test_' then
    select * into v_job from public.publication_jobs
     where post_id = p_post_id and vk_post_id = p_vk_post_id
     order by created_at desc limit 1;
    if v_job.id is null or v_job.status <> 'done' or v_job.remote_cancel_state <> 'none' then
      raise exception 'VK не подтверждён как активная публикация; статус не будет отмечен опубликованным' using errcode = '42501';
    end if;
  end if;

  update public.posts set status = 'published',
    published_at = coalesce(p_published_at, now()),
    vk_post_id = coalesce(p_vk_post_id, vk_post_id), error_message = null
   where id = p_post_id;
  perform app.notify('published', 'Пост опубликован', coalesce(nullif(v_post.title, ''), v_post.topic), '/posts/' || p_post_id);
  perform app.log_audit('published', 'post', p_post_id, jsonb_build_object('vkPostId', p_vk_post_id));
  return app.post_json(p_post_id);
end;
$$;

-- Unknown, pending or unconfirmed remote IDs block same-version re-use. After
-- confirmed deletion, an owner may explicitly schedule the still-approved version again.

-- RPC access: owner request; server-only claim/dispatch/finish operations.
revoke all on function public.begin_post_unschedule(text,text) from public, anon;
grant execute on function public.begin_post_unschedule(text,text) to authenticated;
revoke all on function public.finish_post_unschedule(uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.finish_post_unschedule(uuid,text,text,text,text) to service_role;
revoke all on function public.begin_publication_dispatch(uuid,text) from public, anon, authenticated;
grant execute on function public.begin_publication_dispatch(uuid,text) to service_role;
revoke all on function public.finish_publication_attempt(uuid,text,text,text,integer,boolean) from public, anon, authenticated;
grant execute on function public.finish_publication_attempt(uuid,text,text,text,integer,boolean) to service_role;
revoke all on function public.claim_publication_job(text) from public, anon, authenticated;
grant execute on function public.claim_publication_job(text) to service_role;
revoke all on function public.requeue_stale_jobs(integer) from public, anon, authenticated;
grant execute on function public.requeue_stale_jobs(integer) to service_role;
revoke all on function public.finish_publication_job(uuid,boolean,text,text,integer) from public, anon, authenticated;
grant execute on function public.finish_publication_job(uuid,boolean,text,text,integer) to service_role;
revoke all on function public.schedule_post(text) from public, anon;
grant execute on function public.schedule_post(text) to authenticated;
revoke all on function public.unschedule_post(text,text) from public, anon;
grant execute on function public.unschedule_post(text,text) to authenticated;

-- This migration does not call VK. Wall.post/wall.delete are invoked only by
-- Edge Functions after the database gates and only the owner may request cancel.
