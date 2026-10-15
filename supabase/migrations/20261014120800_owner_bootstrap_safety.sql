-- Owner bootstrap is server-side only. Ordinary Auth signups can never become owner.
alter table public.profiles alter column role set default 'viewer';

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
    coalesce(new.raw_user_meta_data ->> 'name', split_part(coalesce(new.email, 'user'), '@', 1)),
    'viewer'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create table if not exists public.owner_bootstrap_state (
  id boolean primary key default true check (id),
  setup_email text,
  user_id uuid references auth.users(id) on delete restrict,
  claimed boolean not null default false,
  completed boolean not null default false,
  claimed_at timestamptz,
  completed_at timestamptz,
  check (not completed or (claimed and user_id is not null and completed_at is not null))
);

alter table public.owner_bootstrap_state enable row level security;
revoke all on table public.owner_bootstrap_state from public, anon, authenticated;
grant all on table public.owner_bootstrap_state to service_role;

create or replace function public.claim_owner_bootstrap(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_state public.owner_bootstrap_state;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_new_claim boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Недостаточно прав для первичной настройки владельца' using errcode = '42501';
  end if;
  if v_email = '' or length(v_email) > 200 or position('@' in v_email) = 0 then
    raise exception 'Укажите корректный email владельца' using errcode = '22023';
  end if;

  -- Serialize claims and completions; the row is a durable one-time latch.
  perform pg_advisory_xact_lock(hashtext('vkbablo-owner-bootstrap')::bigint);
  if exists (select 1 from public.profiles where role = 'owner') then
    return jsonb_build_object('claimed', false, 'reason', 'already_setup');
  end if;

  select * into v_state from public.owner_bootstrap_state where id = true for update;
  if not found then
    if exists (select 1 from auth.users where lower(email) = v_email) then
      return jsonb_build_object('claimed', false, 'reason', 'email_exists');
    end if;
    insert into public.owner_bootstrap_state (id, setup_email, claimed, claimed_at)
    values (true, v_email, true, now());
    v_new_claim := true;
    select * into v_state from public.owner_bootstrap_state where id = true for update;
  elsif v_state.completed then
    return jsonb_build_object('claimed', false, 'reason', 'already_used');
  elsif v_state.claimed then
    if lower(coalesce(v_state.setup_email, '')) <> v_email then
      return jsonb_build_object('claimed', false, 'reason', 'in_progress');
    end if;
    return jsonb_build_object(
      'claimed', true,
      'resume', true,
      'userId', v_state.user_id
    );
  else
    if exists (select 1 from auth.users where lower(email) = v_email) then
      return jsonb_build_object('claimed', false, 'reason', 'email_exists');
    end if;
    update public.owner_bootstrap_state
       set setup_email = v_email, user_id = null, claimed = true, completed = false,
           claimed_at = now(), completed_at = null
     where id = true;
    v_state.user_id := null;
    v_new_claim := true;
  end if;

  return jsonb_build_object(
    'claimed', true,
    'resume', not v_new_claim,
    'userId', v_state.user_id
  );
end;
$$;

create or replace function public.record_owner_bootstrap_user(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_state public.owner_bootstrap_state;
  v_email text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Недостаточно прав для первичной настройки владельца' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('vkbablo-owner-bootstrap')::bigint);
  select * into v_state from public.owner_bootstrap_state where id = true for update;
  if not found or not v_state.claimed or v_state.completed then
    raise exception 'Одноразовая настройка владельца не зарезервирована' using errcode = '23514';
  end if;

  select lower(email) into v_email from auth.users where id = p_user_id;
  if v_email is null or v_email <> lower(coalesce(v_state.setup_email, '')) then
    raise exception 'Учетная запись не совпадает с зарезервированным email' using errcode = '23514';
  end if;
  if v_state.user_id is not null and v_state.user_id <> p_user_id then
    raise exception 'Для одноразовой настройки уже выбрана другая учетная запись' using errcode = '23514';
  end if;

  update public.owner_bootstrap_state set user_id = p_user_id where id = true;
  return jsonb_build_object('recorded', true);
end;
$$;

create or replace function public.complete_owner_bootstrap(p_user_id uuid, p_email text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_state public.owner_bootstrap_state;
  v_auth_email text;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name text := left(coalesce(nullif(trim(p_name), ''), 'Владелец'), 120);
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Недостаточно прав для первичной настройки владельца' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('vkbablo-owner-bootstrap')::bigint);
  select * into v_state from public.owner_bootstrap_state where id = true for update;
  if not found then
    raise exception 'Одноразовая настройка владельца не найдена' using errcode = '23514';
  end if;
  if v_state.completed then
    if v_state.user_id = p_user_id then
      return jsonb_build_object('completed', true, 'alreadyCompleted', true);
    end if;
    raise exception 'Одноразовая настройка уже завершена' using errcode = '23514';
  end if;
  if not v_state.claimed
     or lower(coalesce(v_state.setup_email, '')) <> v_email
     or v_state.user_id is distinct from p_user_id then
    raise exception 'Заявка на первичную настройку не совпадает с резервированием' using errcode = '23514';
  end if;
  if exists (select 1 from public.profiles where role = 'owner' and id <> p_user_id) then
    raise exception 'Владелец уже создан другим пользователем' using errcode = '23514';
  end if;

  select lower(email) into v_auth_email from auth.users where id = p_user_id;
  if v_auth_email is null or v_auth_email <> v_email then
    raise exception 'Auth-пользователь не совпадает с указанным email' using errcode = '23514';
  end if;

  -- The Auth trigger creates only a viewer profile. Promotion happens here,
  -- under the same lock as the one-time latch and only for the reserved user.
  insert into public.profiles (id, email, name, role)
  values (p_user_id, v_auth_email, v_name, 'owner')
  on conflict (id) do update set
    email = excluded.email,
    name = excluded.name,
    role = 'owner';

  insert into public.audit_logs (user_id, action, entity_type, entity_id, details, result)
  values (
    p_user_id,
    'owner_bootstrap',
    'profile',
    p_user_id::text,
    jsonb_build_object('source', 'operator_cli'),
    'ok'
  );

  update public.owner_bootstrap_state
     set user_id = p_user_id, claimed = true, completed = true, completed_at = now()
   where id = true;

  return jsonb_build_object('completed', true, 'alreadyCompleted', false);
end;
$$;

revoke all on function public.claim_owner_bootstrap(text) from public, anon, authenticated;
revoke all on function public.record_owner_bootstrap_user(uuid) from public, anon, authenticated;
revoke all on function public.complete_owner_bootstrap(uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_owner_bootstrap(text) to service_role;
grant execute on function public.record_owner_bootstrap_user(uuid) to service_role;
grant execute on function public.complete_owner_bootstrap(uuid, text, text) to service_role;
