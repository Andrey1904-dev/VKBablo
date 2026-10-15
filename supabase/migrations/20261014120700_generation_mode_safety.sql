-- Generation safety: a force flag must never overwrite an active VK schedule or history.
-- enqueue_generation may request a transition to `generating`; reject only that transition
-- from statuses that represent a live or already-published VK post.
create or replace function app.prevent_generation_of_live_post()
returns trigger
language plpgsql
set search_path = public, app, pg_temp
as $$
begin
  if old.status in ('scheduled', 'published') and new.status = 'generating' then
    raise exception 'Запланированную или опубликованную публикацию нельзя генерировать заново; сначала отмените планирование или создайте новый слот.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists posts_no_regeneration_of_live_post on public.posts;
create trigger posts_no_regeneration_of_live_post
  before update of status on public.posts
  for each row
  when (old.status in ('scheduled', 'published') and new.status = 'generating')
  execute function app.prevent_generation_of_live_post();
