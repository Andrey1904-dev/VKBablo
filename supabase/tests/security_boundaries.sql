-- Integration/regression assertions for media approval digests and owner/editor
-- privilege boundaries. Run against a disposable Supabase database after all
-- migrations and seeds: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f this file.
begin;

do $$
declare
  v_user_id uuid;
  v_path text := 'posts/security-boundary-' || gen_random_uuid()::text || '.png';
  v_post_id text := 'post_security_' || replace(gen_random_uuid()::text, '-', '');
  v_job_id uuid := gen_random_uuid();
  v_scheduled_at timestamptz := '2099-01-01 12:00:00+00';
  v_hash text;
  v_image_sha text := repeat('a', 64);
  v_rejected boolean := false;
  v_definition text;
  v_profile_check text;
begin
  -- Exercise role helpers using an existing bootstrapped owner profile, then
  -- restore it inside this transaction (the final ROLLBACK leaves it untouched).
  select id into v_user_id from public.profiles where role = 'owner' order by created_at limit 1;
  if v_user_id is null then
    raise exception 'security_boundaries.sql requires one bootstrapped owner profile';
  end if;
  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  if not app.is_owner() or not app.is_editor() then
    raise exception 'Owner must satisfy both app.is_owner() and app.is_editor()';
  end if;
  perform app.assert_owner();
  perform app.assert_editor();

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  v_rejected := false;
  begin
    update public.profiles set role = 'editor' where id = v_user_id;
  exception when insufficient_privilege then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'Authenticated profile update changed its own role'; end if;

  -- Simulate the trusted server-only role assignment path for the rest of the test.
  perform set_config('request.jwt.claim.role', 'service_role', true);
  update public.profiles set role = 'editor' where id = v_user_id;
  if app.is_owner() then raise exception 'Editor was treated as owner'; end if;
  if not app.is_editor() then raise exception 'Editor lost operational access'; end if;
  v_rejected := false;
  begin
    perform app.assert_owner();
  exception when insufficient_privilege then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'Editor passed app.assert_owner()'; end if;
  perform app.assert_editor();

  v_rejected := false;
  begin
    perform public.get_settings();
  exception when insufficient_privilege then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'Editor read owner-only security settings'; end if;

  update public.profiles set role = 'owner' where id = v_user_id;
  if not app.is_owner() then raise exception 'Owner role was not restored inside the test'; end if;

  -- Function ACL is defense in depth around spend details; settings/dashboard
  -- expose it only after their own owner check.
  if has_function_privilege('authenticated', 'public.month_spend_usd()', 'EXECUTE') then
    raise exception 'authenticated can call the raw AI spend RPC';
  end if;
  if not has_function_privilege('authenticated', 'public.get_settings()', 'EXECUTE') then
    raise exception 'authenticated cannot call the owner-guarded settings RPC';
  end if;

  if exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'media_owner_update'
  ) then
    raise exception 'Storage UPDATE/upsert policy media_owner_update still exists';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'application_settings'
       and policyname = 'application_settings_owner_read'
       and qual like '%app.is_owner()%'
  ) then
    raise exception 'application_settings RLS is not owner-only';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'posts'
       and policyname = 'posts_editor_read'
       and qual like '%app.is_editor()%'
  ) then
    raise exception 'Operational post read policy is not shared with editors';
  end if;
  select with_check into v_profile_check from pg_policies
   where schemaname = 'public' and tablename = 'profiles'
     and policyname = 'profiles_update_own';
  if v_profile_check is null or v_profile_check ilike '%profiles%' then
    raise exception 'Profile update policy is missing or recursively queries profiles';
  end if;

  insert into public.media_assets (bucket, path, mime_type, size_bytes, sha256, kind)
  values ('media', v_path, 'image/png', 9, v_image_sha, 'post_image');
  v_rejected := false;
  begin
    update public.media_assets set sha256 = repeat('b', 64)
     where bucket = 'media' and path = v_path;
  exception when check_violation then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'Storage metadata digest was mutable'; end if;

  -- The final DB dispatch fence rejects a job whose frozen image digest differs
  -- from the metadata digest captured when the owner approved the post.
  v_hash := app.content_hash('stories', 'Approved image test', v_path, v_scheduled_at);
  insert into public.posts (
    id, community_id, status, scheduled_at, title, text, image_path,
    approved_hash, approved_image_sha256, approved_at
  ) values (
    v_post_id, 'stories', 'scheduled', v_scheduled_at, 'Security test', 'Approved image test', v_path,
    v_hash, v_image_sha, now()
  );

  insert into public.publication_jobs (
    id, post_id, community_id, version_hash, image_sha256, scheduled_at,
    status, dry_run, idempotency_key
  ) values (
    v_job_id, v_post_id, 'stories', v_hash, repeat('b', 64), v_scheduled_at,
    'running', false, 'security-test:' || v_job_id::text
  );

  v_rejected := false;
  begin
    update public.publication_jobs set dispatch_started_at = now() where id = v_job_id;
  exception when check_violation then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'Publication DB fence accepted an image digest different from approval';
  end if;

  v_definition := pg_get_functiondef('public.approve_post(text,text)'::regprocedure);
  if v_definition not like '%app.assert_owner()%' then
    raise exception 'approve_post is not owner-only';
  end if;
  v_definition := pg_get_functiondef('public.schedule_post(text)'::regprocedure);
  if v_definition not like '%app.assert_owner()%' then
    raise exception 'schedule_post is not owner-only';
  end if;

  raise notice 'Owner/editor, settings RLS, immutable media metadata and dispatch digest checks passed';
end $$;

rollback;

-- Emit a result after rollback for CLI/Management API clients.
select 'security_boundaries: PASS (transaction rolled back)' as result;
