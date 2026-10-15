-- Rollback-only explicit fixtures: approval reset, legacy digest rejection,
-- unknown publication quarantine. Does not call HTTP/VK/AI.
begin;
set local request.jwt.claim.role='service_role';
do $$
declare uid uuid; pid text := 'post_runtime_'||replace(gen_random_uuid()::text,'-','');
 path text := 'posts/runtime-'||gen_random_uuid()::text||'.png';
 at timestamptz := now()+interval '100 years'; jid uuid:=gen_random_uuid(); rejected boolean:=false;
begin
 select id into uid from profiles where role='owner' limit 1;
 if uid is null then raise exception 'Test owner required'; end if;
 perform set_config('request.jwt.claim.sub',uid::text,true);
 insert into media_assets(bucket,path,mime_type,size_bytes,sha256,kind)
 values('media',path,'image/png',9,repeat('a',64),'post_image');
 insert into posts(id,community_id,status,scheduled_at,title,text,image_path)
 values(pid,'stories','review',at,'EXPLICIT SQL TEST FIXTURE','Approval reset test',path);
 perform public.approve_post(pid,'Explicit rollback-only test fixture');
 if not exists(select 1 from posts where id=pid and approved_image_sha256=repeat('a',64)) then raise exception 'Digest not approved'; end if;
 update posts set text='Changed explicit SQL test fixture' where id=pid;
 if exists(select 1 from posts where id=pid and (approved_hash is not null or approved_image_sha256 is not null or not test_mode)) then raise exception 'Content edit retained approval'; end if;
 begin
  update posts set status='approved',approved_hash=content_hash,approved_image_sha256=null where id=pid;
 exception when check_violation then rejected:=true; end;
 if not rejected then raise exception 'Approval without verifiable digest accepted'; end if;
 insert into publication_jobs(id,post_id,community_id,version_hash,image_sha256,scheduled_at,status,dry_run,idempotency_key,locked_at,locked_by,dispatch_started_at)
 select jid,id,community_id,content_hash,repeat('a',64),scheduled_at,'running',false,'explicit-unknown:'||jid,now()-interval '20 minutes','test-crash',now()-interval '20 minutes' from posts where id=pid;
 perform public.requeue_stale_jobs(600);
 if not exists(select 1 from publication_jobs where id=jid and status='unknown') then raise exception 'Dispatch outcome not quarantined'; end if;
 if exists(select 1 from publication_jobs where id=jid and status='queued') then raise exception 'Unknown dispatch retried'; end if;
end $$;
rollback;
select 'runtime_integrity: PASS (rollback-only fixtures, no HTTP)' as result;
