-- RLS and storage policies. Run after 0001_init.sql.
-- Anon: no table access.
-- Authenticated (owner): operational data, never community_secrets.
-- Service role: used only on the Worker after verifying the user.

alter table public.profiles enable row level security;
alter table public.communities enable row level security;
alter table public.community_secrets enable row level security;
alter table public.characters enable row level security;
alter table public.character_references enable row level security;
alter table public.posts enable row level security;
alter table public.post_versions enable row level security;
alter table public.approvals enable row level security;
alter table public.topics enable row level security;
alter table public.generation_jobs enable row level security;
alter table public.publication_jobs enable row level security;
alter table public.post_statistics enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_logs enable row level security;
alter table public.settings enable row level security;
alter table public.jobs enable row level security;

-- No policies on community_secrets → even authenticated cannot read VK tokens.

create policy "profiles_self" on public.profiles
  for all to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "owner_read_communities" on public.communities
  for select to authenticated using (true);
create policy "owner_write_communities" on public.communities
  for all to authenticated using (true) with check (true);

create policy "owner_all_characters" on public.characters
  for all to authenticated using (true) with check (true);
create policy "owner_all_refs" on public.character_references
  for all to authenticated using (true) with check (true);
create policy "owner_all_posts" on public.posts
  for all to authenticated using (true) with check (true);
create policy "owner_all_versions" on public.post_versions
  for all to authenticated using (true) with check (true);
create policy "owner_all_approvals" on public.approvals
  for all to authenticated using (true) with check (true);
create policy "owner_all_topics" on public.topics
  for all to authenticated using (true) with check (true);
create policy "owner_all_gen_jobs" on public.generation_jobs
  for all to authenticated using (true) with check (true);
create policy "owner_all_pub_jobs" on public.publication_jobs
  for all to authenticated using (true) with check (true);
create policy "owner_all_stats" on public.post_statistics
  for all to authenticated using (true) with check (true);
create policy "owner_all_notifications" on public.notifications
  for all to authenticated using (true) with check (true);
create policy "owner_read_audit" on public.audit_logs
  for select to authenticated using (true);
create policy "owner_all_settings" on public.settings
  for all to authenticated using (true) with check (true);
create policy "owner_all_jobs" on public.jobs
  for all to authenticated using (true) with check (true);

-- Storage: private bucket `media`
-- Create bucket in dashboard: name=media, public=false, 15MB limit, mime image/* + image/svg+xml
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media',
  'media',
  false,
  15000000,
  array['image/png','image/jpeg','image/webp','image/svg+xml','image/gif']
)
on conflict (id) do nothing;

create policy "media_auth_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'media');

create policy "media_auth_write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'media');

create policy "media_auth_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'media')
  with check (bucket_id = 'media');

-- Deletes only via service role (Worker), to avoid dropping images still used by posts.

-- Realtime publication
begin;
  drop publication if exists supabase_realtime;
  create publication supabase_realtime for table
    public.posts,
    public.notifications,
    public.generation_jobs,
    public.publication_jobs;
commit;
