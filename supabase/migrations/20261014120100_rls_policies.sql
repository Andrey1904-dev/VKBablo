-- =============================================================================
-- VK AI Manager — Row Level Security
--
-- Принципы:
--  1. `anon` не имеет доступа ни к одной таблице.
--  2. `authenticated` (владелец) ЧИТАЕТ операционные данные через RLS.
--  3. Критические изменения (одобрение, планирование, отправка, персонажи,
--     правила, настройки) выполняются ТОЛЬКО через RPC/Edge Functions
--     с серверной проверкой прав — прямых политик INSERT/UPDATE нет.
--  4. Секреты (community_secrets, integration_secrets) не видны даже владельцу
--     через API: политик нет вообще.
-- =============================================================================

alter table public.profiles              enable row level security;
alter table public.communities           enable row level security;
alter table public.schedules             enable row level security;
alter table public.community_rules       enable row level security;
alter table public.community_rule_versions enable row level security;
alter table public.characters            enable row level security;
alter table public.character_references  enable row level security;
alter table public.posts                 enable row level security;
alter table public.post_versions         enable row level security;
alter table public.approvals             enable row level security;
alter table public.topics                enable row level security;
alter table public.media_assets          enable row level security;
alter table public.ai_providers          enable row level security;
alter table public.ai_prompt_templates   enable row level security;
alter table public.ai_generations        enable row level security;
alter table public.generation_jobs       enable row level security;
alter table public.publication_jobs      enable row level security;
alter table public.jobs                  enable row level security;
alter table public.post_statistics       enable row level security;
alter table public.analytics_snapshots   enable row level security;
alter table public.notifications         enable row level security;
alter table public.integration_status    enable row level security;
alter table public.audit_logs            enable row level security;
alter table public.application_settings  enable row level security;
alter table public.rate_limits           enable row level security;
alter table public.community_secrets     enable row level security;
alter table public.integration_secrets   enable row level security;

-- Никаких прав для anon: явный отзыв.
revoke all on all tables in schema public from anon;
revoke all on schema public from anon;

grant usage on schema public to authenticated;

-- --------------------------------------------------------------------------
-- profiles
-- --------------------------------------------------------------------------
drop policy if exists profiles_read_own on public.profiles;
create policy profiles_read_own on public.profiles
  for select to authenticated
  using (id = auth.uid() or app.is_owner());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from public.profiles where id = auth.uid()));

-- --------------------------------------------------------------------------
-- Только чтение для владельца (запись — через RPC / service role)
-- --------------------------------------------------------------------------
do $$
declare
  t text;
  readable text[] := array[
    'communities','schedules','community_rules','community_rule_versions',
    'characters','character_references','posts','post_versions','approvals','topics',
    'media_assets','ai_providers','ai_prompt_templates','ai_generations',
    'generation_jobs','publication_jobs','jobs','post_statistics','analytics_snapshots',
    'notifications','integration_status','audit_logs','application_settings'
  ];
begin
  foreach t in array readable loop
    execute format('drop policy if exists %I on public.%I', t || '_owner_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (app.is_owner())',
      t || '_owner_read', t
    );
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- rate_limits и секреты — без прав чтения у authenticated.
revoke all on public.rate_limits from authenticated;
revoke all on public.community_secrets from authenticated;
revoke all on public.integration_secrets from authenticated;

-- --------------------------------------------------------------------------
-- Функции: anon не может вызывать ничего, authenticated — только публичные обёртки
-- --------------------------------------------------------------------------
revoke all on all functions in schema app from public, anon;
grant execute on function app.is_owner() to authenticated;
revoke all on all functions in schema public from public, anon;

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    execute format('revoke all on function %s from anon', f.sig);
  end loop;
end $$;

-- --------------------------------------------------------------------------
-- Storage: приватный bucket media
-- --------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media', 'media', false, 12582912,
  array['image/png','image/jpeg','image/webp','image/svg+xml','image/gif']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists media_owner_read on storage.objects;
create policy media_owner_read on storage.objects
  for select to authenticated
  using (bucket_id = 'media' and app.is_owner());

drop policy if exists media_owner_insert on storage.objects;
create policy media_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'media'
    and app.is_owner()
    -- разрешены только рабочие префиксы
    and (storage.foldername(name))[1] in ('communities','characters','posts','generated','archive')
  );

drop policy if exists media_owner_update on storage.objects;
create policy media_owner_update on storage.objects
  for update to authenticated
  using (bucket_id = 'media' and app.is_owner())
  with check (bucket_id = 'media' and app.is_owner());

-- Удаление — только service role (Edge Function проверяет, что файл не используется).
drop policy if exists media_owner_delete on storage.objects;
