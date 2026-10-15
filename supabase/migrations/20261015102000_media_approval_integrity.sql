-- Bind every live VK publication to immutable media metadata and the exact bytes
-- captured when an owner approved the post. Storage objects are immutable to
-- authenticated clients; a changed object also fails the worker's byte hash.

alter table public.media_assets
  add column if not exists sha256 text;
alter table public.posts
  add column if not exists approved_image_sha256 text;
alter table public.publication_jobs
  add column if not exists image_sha256 text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.media_assets'::regclass and conname = 'media_assets_sha256_format_check') then
    alter table public.media_assets add constraint media_assets_sha256_format_check
      check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$');
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.posts'::regclass and conname = 'posts_approved_image_sha256_format_check') then
    alter table public.posts add constraint posts_approved_image_sha256_format_check
      check (approved_image_sha256 is null or approved_image_sha256 ~ '^[0-9a-f]{64}$');
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.publication_jobs'::regclass and conname = 'publication_jobs_image_sha256_format_check') then
    alter table public.publication_jobs add constraint publication_jobs_image_sha256_format_check
      check (image_sha256 is null or image_sha256 ~ '^[0-9a-f]{64}$');
  end if;
end $$;

-- One row is the authoritative metadata record for one Storage object.
create unique index if not exists media_assets_bucket_path_unique
  on public.media_assets(bucket, path);

-- Earlier approvals only hashed the object path. They cannot be safely upgraded
-- because the database cannot reconstruct historical object bytes. Require a
-- fresh upload and owner approval rather than preserving those approvals.
update public.posts
   set status = 'review',
       approved_hash = null,
       approved_at = null,
       approved_by = null,
       approved_image_sha256 = null,
       test_mode = true,
       error_message = 'Требуется повторно загрузить PNG/JPEG и одобрить его: прежнее одобрение не было привязано к байтам файла.'
 where status in ('approved', 'scheduled');

-- Jobs that have not started a possible remote wall.post are safe to cancel.
-- A job past the dispatch fence is deliberately left for the existing unknown-
-- outcome reconciliation; it must never be silently retried.
update public.publication_jobs
   set status = 'cancelled',
       locked_at = null,
       locked_by = null,
       last_error = 'Одобрение изображения не содержит SHA-256; требуется новая загрузка и одобрение.'
 where image_sha256 is null
   and status in ('queued', 'running')
   and dispatch_started_at is null
   and (vk_post_id is null or left(vk_post_id, 5) = 'test_');

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.posts'::regclass and conname = 'posts_active_approval_requires_image_sha256') then
    alter table public.posts add constraint posts_active_approval_requires_image_sha256
      check (status not in ('approved', 'scheduled') or (approved_image_sha256 is not null and approved_image_sha256 ~ '^[0-9a-f]{64}$'));
  end if;
end $$;

-- Do not permit an authenticated owner/editor to update/overwrite an object.
-- Keep INSERT for fresh UUID paths; server uploaders additionally use upsert=false.
drop policy if exists media_owner_update on storage.objects;

-- Image identity (path + MIME + byte hash) is write-once metadata. A file can
-- be deleted through the guarded service path, but its record cannot be edited
-- to make a different object appear to retain the same approval.
create or replace function app.prevent_media_asset_identity_change()
returns trigger
language plpgsql
set search_path = public, app, pg_temp
as $$
begin
  if row(new.bucket, new.path, new.mime_type, new.size_bytes, new.sha256)
     is distinct from row(old.bucket, old.path, old.mime_type, old.size_bytes, old.sha256) then
    raise exception 'Метаданные Storage-объекта неизменяемы; загрузите новый файл с новым путём'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists media_assets_identity_immutable on public.media_assets;
create trigger media_assets_identity_immutable
  before update of bucket, path, mime_type, size_bytes, sha256 on public.media_assets
  for each row execute function app.prevent_media_asset_identity_change();

-- Preserve an approved digest only while the approval is still for the same
-- canonical post version. Cosmetic text normalization follows app.content_hash.
create or replace function app.posts_sync_approved_image_digest()
returns trigger
language plpgsql
set search_path = public, app, pg_temp
as $$
declare
  v_current_hash text;
begin
  v_current_hash := app.content_hash(new.community_id, new.text, new.image_path, new.scheduled_at);
  if new.approved_hash is null or new.approved_hash is distinct from v_current_hash then
    new.approved_image_sha256 := null;
  end if;
  return new;
end;
$$;

drop trigger if exists posts_approved_image_digest_guard on public.posts;
create trigger posts_approved_image_digest_guard
  before insert or update on public.posts
  for each row execute function app.posts_sync_approved_image_digest();

-- Approval captures the registered media SHA-256 and refuses any format that
-- the downstream VK photos.getWallUploadServer/photos.saveWallPhoto flow rejects.
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
  v_image_sha256 text;
  v_image_mime text;
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

  select m.sha256, m.mime_type into v_image_sha256, v_image_mime
    from public.media_assets m
   where m.bucket = 'media' and m.path = v_post.image_path
   limit 1;
  if v_image_sha256 is null or v_image_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Изображение не имеет проверенного SHA-256. Загрузите файл заново перед одобрением.'
      using errcode = '23514';
  end if;
  if v_image_mime not in ('image/png', 'image/jpeg')
     or lower(v_post.image_path) !~ '[.](png|jpe?g)$' then
    raise exception 'Одобрить можно только PNG или JPEG: это единственные форматы, поддерживаемые публикацией VK.'
      using errcode = '23514';
  end if;

  v_hash := app.content_hash(v_post.community_id, v_post.text, v_post.image_path, v_post.scheduled_at);

  update public.posts
     set status = 'approved',
         approved_hash = v_hash,
         content_hash = v_hash,
         approved_image_sha256 = v_image_sha256,
         approved_at = now(),
         approved_by = v_uid,
         test_mode = not app.get_bool_setting('real_publish_enabled', false),
         error_message = null
   where id = p_post_id;

  insert into public.approvals (post_id, version_hash, action, comment, user_id)
  values (p_post_id, v_hash, 'approve', coalesce(p_comment, ''), v_uid);

  perform app.log_audit('approve', 'post', p_post_id,
    jsonb_build_object('hash', v_hash, 'imageSha256', v_image_sha256));
  return app.post_json(p_post_id);
end;
$$;

-- At scheduling time freeze the image digest into the job as a second snapshot.
-- A stale job cannot be rebound to another image just by retaining the path hash.
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
  if v_post.approved_image_sha256 is null or v_post.approved_image_sha256 !~ '^[0-9a-f]{64}$'
     or not exists (
       select 1 from public.media_assets m
        where m.bucket = 'media' and m.path = v_post.image_path
          and m.sha256 = v_post.approved_image_sha256
          and m.mime_type in ('image/png','image/jpeg')
          and lower(v_post.image_path) ~ '[.](png|jpe?g)$'
     ) then
    raise exception 'Одобренный PNG/JPEG не совпадает с проверенными метаданными Storage; загрузите и одобрите версию заново.'
      using errcode = '23514';
  end if;
  if v_post.scheduled_at < now() + interval '60 seconds' then
    raise exception 'Время публикации уже прошло или слишком близко' using errcode = '23514';
  end if;

  v_dry_run := app.get_setting('app_mode', 'test') <> 'approval'
               or not app.get_bool_setting('real_publish_enabled', false);
  select c.vk_group_id into v_group from public.communities c where c.id = v_post.community_id;
  if not v_dry_run and coalesce(v_group, '') = '' then
    raise exception 'Сообщество не подключено к VK: укажите Group ID и токен' using errcode = '23514';
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
    post_id, community_id, version_hash, image_sha256, scheduled_at, dry_run, idempotency_key
  ) values (
    v_post.id, v_post.community_id, v_post.approved_hash, v_post.approved_image_sha256,
    v_post.scheduled_at, v_dry_run, v_key
  )
  on conflict (idempotency_key) do update
    set status = 'queued', run_at = now(), last_error = null,
        attempts = 0, dry_run = excluded.dry_run,
        image_sha256 = excluded.image_sha256,
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
    jsonb_build_object('job', v_job.id, 'dryRun', v_dry_run, 'hash', v_post.approved_hash,
                       'imageSha256', v_post.approved_image_sha256));
  perform app.notify(
    'scheduled',
    case when v_dry_run then 'Пост запланирован (dry-run)' else 'Пост передан в очередь VK' end,
    coalesce(nullif(v_post.title, ''), v_post.topic),
    '/posts/' || p_post_id
  );

  return jsonb_build_object('post', app.post_json(p_post_id), 'jobId', v_job.id, 'dryRun', v_dry_run);
end;
$$;

-- Re-check the frozen digest at the final DB dispatch fence. The Edge worker
-- independently hashes the fetched bytes before photos.saveWallPhoto/wall.post.
create or replace function app.guard_publication_image_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_post public.posts;
  v_media public.media_assets;
begin
  if new.dispatch_started_at is null
     or new.dispatch_started_at is not distinct from old.dispatch_started_at
     or new.dry_run then
    return new;
  end if;

  select * into v_post from public.posts where id = new.post_id;
  select * into v_media from public.media_assets
   where bucket = 'media' and path = v_post.image_path
   limit 1;
  if v_post.id is null
     or v_post.status <> 'scheduled'
     or v_post.approved_hash is null
     or v_post.approved_hash <> v_post.content_hash
     or v_post.approved_image_sha256 is null
     or v_post.approved_image_sha256 is distinct from new.image_sha256
     or v_media.sha256 is distinct from new.image_sha256
     or v_media.mime_type not in ('image/png','image/jpeg')
     or lower(v_post.image_path) !~ '[.](png|jpe?g)$' then
    raise exception 'Dispatch image digest differs from the approved PNG/JPEG snapshot'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists publication_jobs_image_snapshot_guard on public.publication_jobs;
create trigger publication_jobs_image_snapshot_guard
  before update of dispatch_started_at on public.publication_jobs
  for each row execute function app.guard_publication_image_snapshot();

revoke all on function app.prevent_media_asset_identity_change() from public, anon, authenticated;
revoke all on function app.posts_sync_approved_image_digest() from public, anon, authenticated;
revoke all on function app.guard_publication_image_snapshot() from public, anon, authenticated;

comment on column public.media_assets.sha256 is 'SHA-256 of exact Storage object bytes; identity metadata is immutable.';
comment on column public.posts.approved_image_sha256 is 'SHA-256 captured at owner approval; real VK sends must use these exact bytes.';
comment on column public.publication_jobs.image_sha256 is 'SHA-256 frozen from the owner-approved image when the publication job is created.';
