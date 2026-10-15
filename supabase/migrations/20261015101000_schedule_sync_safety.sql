-- A schedule slot/metadata edit must not silently resume a community paused
-- independently through communities.status. Keep the mirrored status in sync
-- only when the schedule's paused flag itself changes.
create or replace function app.schedules_sync_communities()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update public.communities
       set schedule = new.slots,
           status = case when new.paused then 'paused' else status end,
           updated_at = now()
     where id = new.community_id;
  elsif new.paused is distinct from old.paused then
    update public.communities
       set schedule = new.slots,
           status = case when new.paused then 'paused' else 'active' end,
           updated_at = now()
     where id = new.community_id;
  else
    update public.communities
       set schedule = new.slots,
           updated_at = now()
     where id = new.community_id;
  end if;
  return new;
end;
$$;
