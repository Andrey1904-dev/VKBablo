-- Optional seed of the four communities and locked characters.
-- Run after migrations + policies. Safe to re-run (upserts by id).

insert into public.communities as c (
  id, name, short_name, tagline, description, theme, color, avatar_url, schedule, status
) values
  ('stories', 'Ну и история', 'Истории', 'Жизненные истории с неожиданным финалом',
   'Юмористические истории, жизненные ситуации, смешные недоразумения и неожиданные концовки.',
   'humor-stories', '#E86A33', '/avatars/stories.svg', '["13:30","17:30","21:30"]', 'active'),
  ('milana', 'Милана и её деревенский гламур', 'Милана', 'Комедия деревенского гламура',
   'Комедийные приключения Миланы и деревенских персонажей, включая Толечку.',
   'village-glamour', '#2FA36B', '/avatars/milana.svg', '["13:30","17:30","21:30"]', 'active'),
  ('life', 'ВСЯ СУТЬ ЖИЗНИ', 'Суть жизни', 'Ностальгия, наблюдения, «раньше и сейчас»',
   'Жизненные наблюдения, ностальгия, сравнения прошлого и настоящего.',
   'life-essence', '#3B7BD6', '/avatars/life.svg', '["13:30","17:30","21:30"]', 'active'),
  ('veronica', 'Вероника в поиске настоящего мужчины', 'Вероника', 'Истории женщины 38 лет о знакомствах и отношениях',
   'Истории и размышления женщины 38 лет. Посты от лица Вероники. Город не указывается.',
   'veronica-dating', '#D4537E', '/avatars/veronica.svg', '["13:30","17:30","21:30"]', 'active')
on conflict (id) do update set name = excluded.name, tagline = excluded.tagline;

insert into public.settings (key, value) values
  ('app_mode', 'test'),
  ('automation_paused', '0'),
  ('timezone', 'Europe/Moscow'),
  ('prepare_hours_ahead', '24'),
  ('ai_provider', 'test')
on conflict (key) do nothing;
