-- Installation compatibility for historical unqualified pgcrypto calls.
-- Supabase installs pgcrypto in extensions; CLI migration sessions omit it.
-- Temporary wrappers are removed by 20261015104000 after qualifying callers.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create function public.digest(text, text) returns bytea
language sql immutable strict set search_path = pg_catalog
as $$ select extensions.digest($1, $2) $$;
create function public.gen_random_bytes(integer) returns bytea
language sql volatile strict set search_path = pg_catalog
as $$ select extensions.gen_random_bytes($1) $$;
revoke all on function public.digest(text,text) from public, anon, authenticated;
revoke all on function public.gen_random_bytes(integer) from public, anon, authenticated;
