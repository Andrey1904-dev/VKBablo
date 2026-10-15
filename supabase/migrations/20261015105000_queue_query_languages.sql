-- Correct the language of SQL-bodied service-only queue queries.
create or replace function public.posts_due_for_publication(p_limit int default 10)
returns jsonb
language sql
security definer
set search_path = public, app, pg_temp
as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select p.id as post_id,
           p.community_id,
           c.vk_group_id,
           p.vk_post_id,
           p.scheduled_at,
           p.test_mode
      from public.posts p
      join public.communities c on c.id = p.community_id
     where p.status = 'scheduled'
       and p.scheduled_at <= now()
     order by p.scheduled_at asc
     limit greatest(1, p_limit)
  ) x;
$$;

create or replace function public.posts_due_for_stats(p_limit int default 20)
returns jsonb
language sql
security definer
set search_path = public, app, pg_temp
as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select p.id as post_id,
           p.community_id,
           p.vk_post_id,
           c.vk_group_id,
           st.last_collected_at
      from public.posts p
      join public.communities c on c.id = p.community_id
      left join lateral (
        select max(s.collected_at) as last_collected_at
          from public.post_statistics s
         where s.post_id = p.id
      ) st on true
     where p.status = 'published'
       and p.vk_post_id is not null
       and p.test_mode = false
       and coalesce(c.vk_group_id, '') <> ''
       -- Не чаще, чем раз в 6 часов, и только для реальных публикаций.
       and (st.last_collected_at is null or st.last_collected_at < now() - interval '6 hours')
     order by p.published_at asc nulls last
     limit greatest(1, p_limit)
  ) x;
$$;
