-- VK AI Manager — PostgreSQL schema for Supabase
-- Apply in the SQL editor or via supabase db push.
-- Service role bypasses RLS; the Worker still MUST verify the user JWT/session.

create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  name text not null,
  role text not null default 'owner' check (role in ('owner', 'editor')),
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

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
  schedule jsonb not null default '["13:30","17:30","21:30"]'::jsonb,
  style_rules jsonb not null default '{}'::jsonb,
  generation_settings jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'paused')),
  automation_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Encrypted VK tokens. No grants to anon/authenticated — only service role.
create table if not exists public.community_secrets (
  community_id text primary key references public.communities(id) on delete cascade,
  vk_token_enc text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.characters (
  id text primary key,
  community_id text not null references public.communities(id) on delete cascade,
  name text not null,
  role text,
  description text,
  appearance jsonb not null default '{}'::jsonb,
  personality text,
  locked boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.character_references (
  id text primary key,
  character_id text not null references public.characters(id) on delete cascade,
  storage_path text not null,
  kind text not null default 'appearance',
  approved boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.posts (
  id text primary key,
  community_id text not null references public.communities(id),
  status text not null check (status in (
    'draft','generating','review','needs_revision','approved',
    'scheduled','published','error','rejected'
  )),
  scheduled_at timestamptz not null,
  published_at timestamptz,
  title text,
  text text not null default '',
  image_path text,
  image_prompt text,
  topic text,
  idea text,
  vk_post_id text,
  content_hash text not null default '',
  approved_hash text,
  approved_at timestamptz,
  approved_by uuid references public.profiles(id),
  error_message text,
  generation_meta jsonb,
  similarity_score double precision,
  similar_to text,
  test_mode boolean not null default true,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (community_id, scheduled_at)
);

create table if not exists public.post_versions (
  id text primary key,
  post_id text not null references public.posts(id) on delete cascade,
  version integer not null,
  text text,
  image_path text,
  image_prompt text,
  content_hash text,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  reason text
);

create table if not exists public.approvals (
  id text primary key,
  post_id text not null references public.posts(id) on delete cascade,
  version_hash text not null,
  action text not null check (action in ('approve','reject','revise')),
  comment text,
  user_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.topics (
  id text primary key,
  community_id text not null references public.communities(id) on delete cascade,
  topic text not null,
  post_id text references public.posts(id),
  created_at timestamptz not null default now()
);

create table if not exists public.generation_jobs (
  id text primary key,
  community_id text references public.communities(id),
  post_id text references public.posts(id),
  type text not null,
  provider text,
  model text,
  status text not null check (status in ('queued','running','done','failed','cancelled')),
  error text,
  cost_usd numeric not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.publication_jobs (
  id text primary key,
  post_id text not null references public.posts(id) on delete cascade,
  version_hash text not null,
  scheduled_at timestamptz not null,
  vk_post_id text,
  status text not null check (status in ('queued','running','done','failed','cancelled')),
  idempotency_key text unique,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.post_statistics (
  id text primary key,
  post_id text not null references public.posts(id) on delete cascade,
  community_id text references public.communities(id),
  views integer not null default 0,
  likes integer not null default 0,
  comments integer not null default 0,
  shares integer not null default 0,
  collected_at timestamptz not null default now(),
  source text not null default 'vk'
);

create table if not exists public.notifications (
  id text primary key,
  type text not null,
  title text not null,
  message text not null,
  link text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id text primary key,
  user_id uuid references public.profiles(id),
  action text not null,
  entity_type text,
  entity_id text,
  details jsonb,
  ip text,
  result text,
  created_at timestamptz not null default now()
);

create table if not exists public.settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.jobs (
  id text primary key,
  type text not null,
  payload jsonb,
  status text not null,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  run_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  idempotency_key text unique,
  created_at timestamptz not null default now()
);

create index if not exists idx_posts_status on public.posts(status);
create index if not exists idx_posts_scheduled on public.posts(scheduled_at);
create index if not exists idx_posts_community on public.posts(community_id, scheduled_at);
create index if not exists idx_versions_post on public.post_versions(post_id, version);
create index if not exists idx_approvals_post on public.approvals(post_id, created_at desc);
create index if not exists idx_pub_jobs_key on public.publication_jobs(idempotency_key);
create index if not exists idx_jobs_status_run on public.jobs(status, run_at);
create index if not exists idx_notifications_read on public.notifications(read, created_at desc);
create index if not exists idx_stats_post on public.post_statistics(post_id, collected_at desc);
create index if not exists idx_gen_jobs_status on public.generation_jobs(status, created_at desc);

-- Realtime
alter table public.posts replica identity full;
alter table public.notifications replica identity full;
alter table public.generation_jobs replica identity full;
alter table public.publication_jobs replica identity full;
