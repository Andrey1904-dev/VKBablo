-- Actual SQL roles + JWT claims; no administrator-only RLS inference.
-- Reuses the test owner and rolls back all profile changes.
begin;
select set_config('verification.uid', (select id::text from public.profiles where role='owner' limit 1), true);
select set_config('verification.other_uid',gen_random_uuid()::text,true);
-- A second rollback-only Auth row makes other-profile visibility testable.
insert into auth.users(id,email,raw_user_meta_data) values(current_setting('verification.other_uid')::uuid,'rls-fixture-'||current_setting('verification.other_uid')||'@example.invalid','{}'::jsonb);
select set_config('request.jwt.claim.sub', current_setting('verification.uid'), true);
set local request.jwt.claim.role = 'authenticated';
set local role authenticated;
do $$ begin
 if not exists(select 1 from public.profiles where id=current_setting('verification.other_uid')::uuid) then raise exception 'owner cannot list other profile'; end if;
 if (select count(*) from public.communities) <> 4 then raise exception 'owner communities'; end if;
 if (select count(*) from public.application_settings) = 0 then raise exception 'owner settings'; end if;
 begin
  perform * from public.community_secrets;
  raise exception 'owner read secrets';
 exception when insufficient_privilege then null; end;
 begin
  update public.profiles set role='editor' where id=auth.uid();
  if found then raise exception 'owner changed own role'; end if;
 exception when insufficient_privilege then null; end;
end $$;
reset role;
set local request.jwt.claim.role = 'service_role';
update public.profiles set role='editor' where id=current_setting('verification.uid')::uuid;
set local request.jwt.claim.role = 'authenticated';
set local role authenticated;
do $$ begin
 if exists(select 1 from public.profiles where id=current_setting('verification.other_uid')::uuid) then raise exception 'editor other-profile leak'; end if;
 if (select count(*) from public.communities) <> 4 then raise exception 'editor operational read'; end if;
 if (select count(*) from public.application_settings) <> 0 then raise exception 'editor settings leak'; end if;
 if (select count(*) from public.integration_status) <> 0 then raise exception 'editor integration leak'; end if;
 begin perform public.get_settings(); raise exception 'editor settings RPC'; exception when insufficient_privilege then null; end;
 begin perform public.approve_post('explicit-nonexistent-fixture'); raise exception 'editor approval'; exception when insufficient_privilege then null; end;
 begin update public.profiles set role='owner' where id=auth.uid(); if found then raise exception 'editor promotion'; end if; exception when insufficient_privilege then null; end;
 begin perform * from public.community_secrets; raise exception 'editor secrets'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local request.jwt.claim.role = 'service_role';
update public.profiles set role='viewer' where id=current_setting('verification.uid')::uuid;
set local request.jwt.claim.role = 'authenticated';
set local role authenticated;
do $$ begin
 if exists(select 1 from public.profiles where id=current_setting('verification.other_uid')::uuid) then raise exception 'viewer other-profile leak'; end if;
 if (select count(*) from public.communities) <> 0 then raise exception 'viewer operational leak'; end if;
 if (select count(*) from public.application_settings) <> 0 then raise exception 'viewer settings leak'; end if;
 begin perform public.get_settings(); raise exception 'viewer settings RPC'; exception when insufficient_privilege then null; end;
 begin update public.profiles set role='owner' where id=auth.uid(); if found then raise exception 'viewer promotion'; end if; exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','',true);
set local request.jwt.claim.role = 'anon';
set local role anon;
do $$ begin
 begin perform * from public.application_settings; raise exception 'anon settings'; exception when insufficient_privilege then null; end;
 begin perform * from public.community_secrets; raise exception 'anon secrets'; exception when insufficient_privilege then null; end;
 begin perform public.approve_post('explicit-nonexistent-fixture'); raise exception 'anon approval'; exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
select 'rls_sessions: PASS (actual anon/authenticated SQL roles, rolled back)' as result;
