-- =============================================================================
-- VK AI Manager — ядро схемы (Supabase PostgreSQL)
-- Этап 3 ТЗ: 21 сущность, ключи, внешние ключи, индексы, ограничения,
-- временные метки, триггеры целостности, Realtime.
--
-- Все даты хранятся в UTC (timestamptz), отображение — Europe/Moscow.
-- Секреты (VK/AI) лежат в таблицах без политик RLS и недоступны браузеру.
-- =============================================================================

create extension if not exists "pgcrypto";

-- Отдельная схема для серверных функций: наружу выставляем только обёртки в public.
create schema if not exists app;

-- ----------------------------------------------------------------------------
-- Хелперы
-- ----------------------------------------------------------------------------

-- Нормализация текста. Должна совпадать с shared/hash.ts → normalizeText().
create or replace function app.normalize_text(p_text text)
returns text
language sql
immutable
as $$
  select btrim(replace(coalesce(p_text, ''), E'\r\n', E'\n'));
$$;

-- Канонический хэш версии публикации.
-- Должен совпадать с shared/hash.ts → contentHash() (проверяется supabase/tests/hash.sql).
create or replace function app.content_hash(
  p_community_id text,
  p_text text,
  p_image_path text,
  p_scheduled_at timestamptz
)
returns text
language sql
immutable
as $$
  select encode(
    digest(
      p_community_id || E'\n' ||
      app.normalize_text(p_text) || E'\n' ||
      coalesce(p_image_path, '') || E'\n' ||
      to_char(p_scheduled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Проверка владельца/редактора по JWT. Используется в RLS и RPC.
create or replace function app.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('owner', 'editor')
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
    raise exception 'Недостаточно прав: нужен владелец' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

create or replace function app.log_audit(
  p_action text,
  p_entity_type text default null,
  p_entity_id text default null,
  p_details jsonb default null,
  p_result text default 'ok'
)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  insert into public.audit_logs (user_id, action, entity_type, entity_id, details, result)
  values (auth.uid(), p_action, p_entity_type, p_entity_id, p_details, p_result);
end;
$$;

create or replace function app.set_setting(p_key text, p_value text)
returns void
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  insert into public.application_settings (key, value, updated_at)
  values (p_key, p_value, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end;
$$;

create or replace function app.get_setting(p_key text, p_default text default null)
returns text
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select coalesce((select value from public.application_settings where key = p_key), p_default);
$$;

create or replace function app.get_bool_setting(p_key text, p_default boolean default false)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select coalesce((select value in ('1', 'true', 'on', 'yes') from public.application_settings where key = p_key), p_default);
$$;

-- ----------------------------------------------------------------------------
-- profiles
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  name text not null default 'Владелец',
  role text not null default 'owner' check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function app.touch_updated_at();

-- Профиль создаётся автоматически при регистрации пользователя в Supabase Auth.
create or replace function app.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  insert into public.profiles (id, email, name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(coalesce(new.email, 'owner'), '@', 1)),
    -- Первый пользователь становится владельцем, остальные — наблюдателями до назначения.
    case when (select count(*) from public.profiles) = 0 then 'owner' else 'viewer' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

create or replace function app.touch_last_login()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  update public.profiles set last_login_at = now() where id = new.id;
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- application_settings — единая точка предохранителей
-- ----------------------------------------------------------------------------
create table if not exists public.application_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- communities + schedules + правила (память сообщества)
-- ----------------------------------------------------------------------------
create table if not exists public.communities (
  id text primary key,
  name text not null,
  short_name text not null,
  tagline text,
  description text,
  theme text,
  color text,
  avatar_url text,
  vk_group_id text,
  vk_screen_name text,
  vk_connected boolean not null default false,
  vk_verified_at timestamptz,
  schedule jsonb not null default '["13:30","17:30","21:30"]'::jsonb,
  style_rules jsonb not null default '{}'::jsonb,
  generation_settings jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'paused')),
  automation_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists communities_touch on public.communities;
create trigger communities_touch before update on public.communities
  for each row execute function app.touch_updated_at();

-- Расписание (ТЗ §8). slots — источник истины, communities.schedule синхронизируется триггером.
create table if not exists public.schedules (
  id uuid primary key default gen_random_uuid(),
  community_id text not null unique references public.communities(id) on delete cascade,
  slots jsonb not null default '["13:30","17:30","21:30"]'::jsonb,
  timezone text not null default 'Europe/Moscow',
  days_of_week int[] not null default '{1,2,3,4,5,6,7}',
  paused boolean not null default false,
  skip_until date,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint schedules_days_valid check (
    array_length(days_of_week, 1) between 1 and 7
    and days_of_week <@ array[1,2,3,4,5,6,7]
  )
);

drop trigger if exists schedules_touch on public.schedules;
create trigger schedules_touch before update on public.schedules
  for each row execute function app.touch_updated_at();

create or replace function app.schedules_sync_communities()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  update public.communities
     set schedule = new.slots,
         status = case when new.paused then 'paused' else 'active' end,
         updated_at = now()
   where id = new.community_id;
  return new;
end;
$$;

drop trigger if exists schedules_sync on public.schedules;
create trigger schedules_sync after insert or update on public.schedules
  for each row execute function app.schedules_sync_communities();

-- Текущие правила сообщества (одна строка на сообщество).
create table if not exists public.community_rules (
  community_id text primary key references public.communities(id) on delete cascade,
  version int not null default 1,
  theme text not null default '',
  text_style text not null default '',
  audience text not null default '',
  forbidden text[] not null default '{}',
  preferred_topics text[] not null default '{}',
  unwanted_topics text[] not null default '{}',
  successful_examples text[] not null default '{}',
  image_rules text not null default '',
  character_rules text not null default '',
  analytics_notes text not null default '',
  sources text[] not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);

drop trigger if exists community_rules_touch on public.community_rules;
create trigger community_rules_touch before update on public.community_rules
  for each row execute function app.touch_updated_at();

-- История изменений правил (§6 ТЗ: версионирование).
create table if not exists public.community_rule_versions (
  id uuid primary key default gen_random_uuid(),
  community_id text not null references public.communities(id) on delete cascade,
  version int not null,
  rules jsonb not null,
  change_note text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  unique (community_id, version)
);

-- ----------------------------------------------------------------------------
-- characters / character_references
-- ----------------------------------------------------------------------------
create table if not exists public.characters (
  id text primary key,
  community_id text not null references public.communities(id) on delete cascade,
  name text not null,
  role text,
  description text,
  appearance jsonb not null default '{}'::jsonb,
  personality text,
  locked boolean not null default true,
  -- placeholder — черновое описание до загрузки утверждённых референсов владельцем.
  appearance_status text not null default 'placeholder' check (appearance_status in ('placeholder', 'approved')),
  primary_reference_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists characters_touch on public.characters;
create trigger characters_touch before update on public.characters
  for each row execute function app.touch_updated_at();

create table if not exists public.character_references (
  id uuid primary key default gen_random_uuid(),
  character_id text not null references public.characters(id) on delete cascade,
  storage_path text not null,
  kind text not null default 'appearance' check (kind in ('appearance', 'style', 'prop')),
  approved boolean not null default false,
  is_primary boolean not null default false,
  notes text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id)
);

create index if not exists idx_character_refs_character on public.character_references(character_id, created_at desc);
create unique index if not exists idx_character_refs_primary
  on public.character_references(character_id) where is_primary;

alter table public.characters
  drop constraint if exists characters_primary_reference_fk;
alter table public.characters
  add constraint characters_primary_reference_fk
  foreign key (primary_reference_id) references public.character_references(id) on delete set null;

-- ----------------------------------------------------------------------------
-- posts + версии + одобрения
-- ----------------------------------------------------------------------------
create table if not exists public.posts (
  id text primary key,
  community_id text not null references public.communities(id),
  status text not null default 'draft' check (status in (
    'draft','generating','review','needs_revision','approved',
    'scheduled','published','error','rejected'
  )),
  scheduled_at timestamptz not null,
  published_at timestamptz,
  title text not null default '',
  text text not null default '',
  image_path text,
  image_prompt text not null default '',
  topic text not null default '',
  idea text not null default '',
  vk_post_id text,
  content_hash text not null default '',
  approved_hash text,
  approved_at timestamptz,
  approved_by uuid references public.profiles(id),
  error_message text,
  generation_meta jsonb,
  similarity_score double precision,
  similar_to text,
  -- true — публикация никогда не уйдёт в VK (демо/dry-run/тест).
  test_mode boolean not null default true,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Одобрение всегда относится к текущей версии контента.
  constraint posts_approval_matches_hash check (approved_hash is null or approved_hash = content_hash),
  constraint posts_scheduled_requires_approval check (status <> 'scheduled' or approved_hash is not null),
  constraint posts_published_requires_approval check (status <> 'published' or approved_hash is not null)
);

create index if not exists idx_posts_status on public.posts(status);
create index if not exists idx_posts_scheduled on public.posts(scheduled_at);
create index if not exists idx_posts_community_slot on public.posts(community_id, scheduled_at);
create index if not exists idx_posts_review on public.posts(community_id, status) where status in ('review','needs_revision');

-- Защита от дублей слотов: один слот — одна публикация (отклонённые слот не держат).
drop index if exists public.idx_posts_slot_unique;
create unique index idx_posts_slot_unique
  on public.posts(community_id, scheduled_at) where status <> 'rejected';

-- Защита от повторной публикации одинакового контента.
drop index if exists public.idx_posts_content_unique;
create unique index idx_posts_content_unique
  on public.posts(community_id, content_hash)
  where status in ('approved','scheduled','published');

-- Триггер: hash всегда актуален, изменение материала сбрасывает одобрение.
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

  if v_hash is distinct from old.content_hash then
    new.content_hash := v_hash;
    -- Материальное изменение — старое одобрение недействительно.
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

drop trigger if exists posts_sync_hash on public.posts;
create trigger posts_sync_hash before insert or update on public.posts
  for each row execute function app.posts_sync_hash();

-- Функция-помощник: одобрение действительно?
create or replace function app.post_is_approved(p_post_id text)
returns boolean
language sql
stable
security definer
set search_path = public, app, pg_temp
as $$
  select exists (
    select 1 from public.posts p
    where p.id = p_post_id
      and p.approved_hash is not null
      and p.approved_hash = p.content_hash
  );
$$;

create table if not exists public.post_versions (
  id uuid primary key default gen_random_uuid(),
  post_id text not null references public.posts(id) on delete cascade,
  version int not null,
  text text not null default '',
  image_path text,
  image_prompt text not null default '',
  content_hash text not null default '',
  reason text not null default 'edit',
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id)
);

create index if not exists idx_post_versions_post on public.post_versions(post_id, version desc);

create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  post_id text not null references public.posts(id) on delete cascade,
  version_hash text not null,
  action text not null check (action in ('approve', 'reject', 'revise')),
  comment text not null default '',
  user_id uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_approvals_post on public.approvals(post_id, created_at desc);

-- История тем — защита от повторов на уровне генерации.
create table if not exists public.topics (
  id uuid primary key default gen_random_uuid(),
  community_id text not null references public.communities(id) on delete cascade,
  topic text not null,
  idea_key text not null default '',
  post_id text references public.posts(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_topics_community on public.topics(community_id, created_at desc);

-- ----------------------------------------------------------------------------
-- media_assets
-- ----------------------------------------------------------------------------
create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  community_id text references public.communities(id) on delete set null,
  post_id text references public.posts(id) on delete set null,
  character_id text references public.characters(id) on delete set null,
  bucket text not null default 'media',
  path text not null,
  mime_type text not null default 'image/png',
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  kind text not null default 'post_image' check (kind in (
    'post_image','character_reference','community_logo','generated','archive'
  )),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id)
);

create index if not exists idx_media_post on public.media_assets(post_id);
create index if not exists idx_media_character on public.media_assets(character_id);

-- ----------------------------------------------------------------------------
-- AI: провайдеры, шаблоны промптов, генерации
-- ----------------------------------------------------------------------------
create table if not exists public.ai_providers (
  id text primary key,
  name text not null,
  kind text not null default 'both' check (kind in ('text', 'image', 'both')),
  base_url text not null default '',
  text_model text not null default '',
  image_model text not null default '',
  supports_references boolean not null default false,
  supports_identity_lock boolean not null default false,
  enabled boolean not null default true,
  price_per_image_usd numeric(10,4) not null default 0,
  price_per_1k_tokens_usd numeric(10,6) not null default 0,
  notes text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_prompt_templates (
  id text primary key,
  community_id text references public.communities(id) on delete cascade,
  kind text not null check (kind in ('idea','text','image','revise','quality')),
  version int not null default 1,
  name text not null,
  template text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (community_id, kind, version, name)
);

create table if not exists public.ai_generations (
  id uuid primary key default gen_random_uuid(),
  community_id text references public.communities(id) on delete set null,
  post_id text references public.posts(id) on delete set null,
  job_id uuid,
  type text not null,
  provider text,
  model text,
  prompt text,
  result text,
  cost_usd numeric(10,4) not null default 0,
  status text not null default 'done',
  error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_generations_created on public.ai_generations(created_at desc);
create index if not exists idx_ai_generations_spend on public.ai_generations(created_at, cost_usd);

-- ----------------------------------------------------------------------------
-- Очереди: generation_jobs, publication_jobs, jobs
-- ----------------------------------------------------------------------------
create table if not exists public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  community_id text not null references public.communities(id) on delete cascade,
  post_id text references public.posts(id) on delete cascade,
  kind text not null check (kind in ('idea','text','image','full_post','regenerate','preview')),
  status text not null default 'queued' check (status in ('queued','running','done','failed','cancelled')),
  priority int not null default 100,
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  provider text,
  model text,
  prompt_template_id text references public.ai_prompt_templates(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  cost_usd numeric(10,4) not null default 0,
  error text,
  idempotency_key text unique,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_generation_jobs_queue on public.generation_jobs(status, run_at, priority);
create index if not exists idx_generation_jobs_post on public.generation_jobs(post_id);

drop trigger if exists generation_jobs_touch on public.generation_jobs;
create trigger generation_jobs_touch before update on public.generation_jobs
  for each row execute function app.touch_updated_at();

create table if not exists public.publication_jobs (
  id uuid primary key default gen_random_uuid(),
  post_id text not null references public.posts(id) on delete cascade,
  community_id text not null references public.communities(id) on delete cascade,
  version_hash text not null,
  scheduled_at timestamptz not null,
  vk_post_id text,
  status text not null default 'queued' check (status in ('queued','running','done','failed','cancelled','skipped')),
  -- true — отправка не уходит в VK (тестовый режим / нет разрешения владельца).
  dry_run boolean not null default true,
  attempts int not null default 0,
  max_attempts int not null default 5,
  run_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_publication_jobs_queue on public.publication_jobs(status, run_at);
create index if not exists idx_publication_jobs_post on public.publication_jobs(post_id, status);

drop trigger if exists publication_jobs_touch on public.publication_jobs;
create trigger publication_jobs_touch before update on public.publication_jobs
  for each row execute function app.touch_updated_at();

-- Общая очередь для служебных задач (статистика, очистка, снимки аналитики).
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','running','done','failed','cancelled')),
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  error text,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_jobs_queue on public.jobs(status, run_at);

drop trigger if exists jobs_touch on public.jobs;
create trigger jobs_touch before update on public.jobs
  for each row execute function app.touch_updated_at();

-- ----------------------------------------------------------------------------
-- Статистика и снимки аналитики
-- ----------------------------------------------------------------------------
create table if not exists public.post_statistics (
  id uuid primary key default gen_random_uuid(),
  post_id text not null references public.posts(id) on delete cascade,
  community_id text references public.communities(id) on delete set null,
  views int not null default 0 check (views >= 0),
  likes int not null default 0 check (likes >= 0),
  comments int not null default 0 check (comments >= 0),
  shares int not null default 0 check (shares >= 0),
  source text not null default 'vk' check (source in ('vk','manual','demo')),
  collected_at timestamptz not null default now()
);

create index if not exists idx_post_statistics_post on public.post_statistics(post_id, collected_at desc);

create table if not exists public.analytics_snapshots (
  id uuid primary key default gen_random_uuid(),
  community_id text references public.communities(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  totals jsonb not null default '{}'::jsonb,
  note text not null default '',
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- notifications / integration_status / audit_logs / rate_limits
-- ----------------------------------------------------------------------------
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in (
    'review','generation_error','publish_error','scheduled','published','missed_slot','vk_connection','system'
  )),
  title text not null,
  message text not null default '',
  link text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_unread on public.notifications(read, created_at desc);

create table if not exists public.integration_status (
  key text primary key,
  label text not null,
  configured boolean not null default false,
  verified boolean not null default false,
  status text not null default 'off' check (status in ('off','configured','verified','error','demo')),
  detail text not null default '',
  checked_at timestamptz
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id text,
  details jsonb,
  ip text,
  result text not null default 'ok',
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_logs_created on public.audit_logs(created_at desc);

create table if not exists public.rate_limits (
  subject text not null,
  bucket text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (subject, bucket)
);

-- ----------------------------------------------------------------------------
-- Секреты: RLS включён, политик нет → доступ только service role.
-- Значения зашифрованы AES-256-GCM серверным ключом (ENCRYPTION_KEY в Edge Functions).
-- ----------------------------------------------------------------------------
create table if not exists public.community_secrets (
  community_id text primary key references public.communities(id) on delete cascade,
  vk_token_enc text not null,
  vk_token_hint text not null default '',
  verified_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.integration_secrets (
  key text primary key,
  value_enc text not null,
  hint text not null default '',
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Realtime
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.posts;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.notifications;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.generation_jobs;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.publication_jobs;
    exception when duplicate_object then null;
    end;
  end if;
end $$;

alter table public.posts replica identity full;
alter table public.notifications replica identity full;
alter table public.generation_jobs replica identity full;
alter table public.publication_jobs replica identity full;
