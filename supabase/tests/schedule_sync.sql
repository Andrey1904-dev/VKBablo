-- Transactional regression check for schedule mirror/status behavior.
-- Requires the normal migrations and seed data; all fixture mutations roll back.
begin;

do $$
declare
  v_slots jsonb := '["12:00"]'::jsonb;
  v_schedule_slots jsonb;
  v_community_slots jsonb;
  v_status text;
begin
  if not exists (select 1 from public.communities where id = 'stories') then
    raise exception 'Expected seeded community stories';
  end if;
  if not exists (select 1 from public.schedules where community_id = 'stories') then
    raise exception 'Expected seeded schedule for stories';
  end if;

  -- Put the schedule in a known unpaused state, then pause the community
  -- independently. A slots-only edit must preserve that independent pause.
  update public.schedules set paused = false where community_id = 'stories';
  update public.communities set status = 'paused' where id = 'stories';
  update public.schedules set slots = v_slots where community_id = 'stories';

  select s.slots, c.schedule, c.status
    into v_schedule_slots, v_community_slots, v_status
    from public.schedules s
    join public.communities c on c.id = s.community_id
   where s.community_id = 'stories';

  if v_schedule_slots <> v_slots then
    raise exception 'Schedule slots were not persisted';
  end if;
  if v_community_slots <> v_schedule_slots then
    raise exception 'communities.schedule was not synchronized from schedules.slots';
  end if;
  if v_status <> 'paused' then
    raise exception 'Slots-only edit unexpectedly changed community status to %', v_status;
  end if;

  -- Actual schedule pause transitions continue to mirror community status.
  update public.schedules set paused = true where community_id = 'stories';
  select status into v_status from public.communities where id = 'stories';
  if v_status <> 'paused' then
    raise exception 'Pausing schedule did not pause community';
  end if;

  update public.schedules set paused = false where community_id = 'stories';
  select status into v_status from public.communities where id = 'stories';
  if v_status <> 'active' then
    raise exception 'Resuming schedule did not activate community';
  end if;
end $$;

rollback;
