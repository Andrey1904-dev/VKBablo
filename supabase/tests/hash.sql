-- =============================================================================
-- Проверка: серверный хэш (PostgreSQL) совпадает с изоморфным JS-хэшем (shared/hash.ts).
-- Запуск: psql "$DATABASE_URL" -f supabase/tests/hash.sql   (или `supabase db test`)
-- Ожидаемые значения рассчитаны shared/hash.ts и проверены против node:crypto
-- (см. server/tests/hash.test.ts). Если тест падает — одобрение версий рассинхронизировано.
-- =============================================================================

do $$
declare
  v_case record;
  v_actual text;
  v_failures int := 0;
begin
  for v_case in
    select * from (values
      (
        'stories',
        E'  Первая строка\r\nВторая строка  ',
        'posts/abc.png',
        '2026-10-15T10:30:00.000Z'::timestamptz,
        '81fb523623dab6ba45eaca3e50ce3bf909e94459eeb8dad7d5dc71790c287eb0'
      ),
      (
        'milana',
        'Милана и Толечка: тест',
        null::text,
        '2026-01-02T18:30:00+03:00'::timestamptz,
        '51102f7386938200332c5c2c937499f6dd89b3c1606f00b3cdc3813444f90c99'
      ),
      (
        'veronica',
        'Мне 38, и я больше не разгоняюсь с первого «привет».',
        'generated/x.jpg',
        '2026-03-05T14:30:00.000Z'::timestamptz,
        '8ab25324b6f62a62268c208edaedaede0b6af6d2fa447d32679657376e19161d'
      )
    ) as c(community_id, text, image_path, scheduled_at, expected)
  loop
    v_actual := app.content_hash(v_case.community_id, v_case.text, v_case.image_path, v_case.scheduled_at);
    if v_actual <> v_case.expected then
      v_failures := v_failures + 1;
      raise warning 'НЕ СОВПАЛО: community=% image=% ожидалось % получено %',
        v_case.community_id, coalesce(v_case.image_path, 'null'), v_case.expected, v_actual;
    end if;
  end loop;

  if v_failures > 0 then
    raise exception 'Проверка хэшей не пройдена: % расхождений', v_failures;
  end if;

  raise notice 'Проверка хэшей пройдена: JS ↔ SQL совпадают';
end $$;

-- Проверка инварианта: одобрение невозможно подделать правкой текста.
do $$
declare
  v_post_id text := 'test_hash_reset';
begin
  insert into public.posts (id, community_id, status, scheduled_at, title, text, image_path)
  values (v_post_id, 'stories', 'review', now() + interval '2 days', 'Проверка', 'Текст публикации', 'posts/x.png')
  on conflict (id) do update set text = 'Текст публикации', image_path = 'posts/x.png';

  update public.posts
     set status = 'approved', approved_hash = content_hash, approved_at = now()
   where id = v_post_id;

  if not exists (select 1 from public.posts where id = v_post_id and status = 'approved') then
    raise exception 'Не удалось одобрить тестовую публикацию';
  end if;

  -- Любое изменение текста обязано сбросить одобрение.
  update public.posts set text = 'Другой текст' where id = v_post_id;

  if exists (select 1 from public.posts where id = v_post_id and approved_hash is not null) then
    raise exception 'ОШИБКА БЕЗОПАСНОСТИ: одобрение не сброшено после изменения текста';
  end if;

  if exists (select 1 from public.posts where id = v_post_id and status in ('approved', 'scheduled')) then
    raise exception 'ОШИБКА БЕЗОПАСНОСТИ: статус остался одобренным после изменения';
  end if;

  delete from public.posts where id = v_post_id;
  raise notice 'Инвариант сброса одобрения работает';
exception
  when others then
    delete from public.posts where id = v_post_id;
    raise;
end $$;
