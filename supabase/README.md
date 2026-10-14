# Подключение Supabase

Секреты в чат не отправляйте. Все значения вставляются только в Dashboard, `.env` или `wrangler secret`.

## 1. Создать проект

1. Откройте [https://supabase.com/dashboard](https://supabase.com/dashboard)
2. New project → регион ближе к вам → задайте сильный пароль БД
3. Project Settings → API:
   - Project URL → `SUPABASE_URL`
   - anon / publishable → `SUPABASE_ANON_KEY` и `VITE_SUPABASE_ANON_KEY`
   - service_role → `SUPABASE_SERVICE_ROLE_KEY` (только сервер)

## 2. Схема и RLS

SQL Editor → выполните по очереди:

1. `supabase/migrations/0001_init.sql`
2. `supabase/policies.sql`

Проверьте:

- Table Editor: таблицы `communities`, `posts`, `approvals`, `community_secrets` и др.
- Authentication → провайдер Email включён
- `community_secrets` не имеет политик для `anon` / `authenticated`

## 3. Storage

Если bucket `media` не создался SQL-ом:

- Storage → New bucket → имя `media`
- Public: **выключен**
- Limit 15 MB
- MIME: `image/png`, `image/jpeg`, `image/webp`, `image/svg+xml`

Папки логические (префиксы ключей):

- `communities/`
- `characters/`
- `posts/`
- `generated/`
- `archive/`

Удаление объектов с клиента запрещено политиками: только Worker (service role), и только если изображение больше не используется.

## 4. Auth

1. Authentication → Users → Add user (владелец) **или** первый вход через UI после того, как сервер переключён на Supabase
2. Триггер профиля (по желанию) можно добавить позже: `auth.users` → `public.profiles`

Пока Supabase не сконфигурирован, панель использует локальные пользователей и cookie-сессии. Это осознанный fallback разработки, не «фейковый облачный аккаунт».

## 5. Realtime

`policies.sql` публикует `posts`, `notifications`, `generation_jobs`, `publication_jobs`.

На клиенте подписка возможна только с anon-ключом **и** валидной сессией, иначе RLS ничего не отдаст.

## 6. Переменные

Сервер / Cloudflare Worker:

```
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

Vite (публичные):

```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

После заполнения перезапустите API. В Настройках статус URL / anon / service должен стать «да». Service role на странице показывается только как факт наличия, не само значение.

## 7. Миграция с локальной SQLite

1. Поднимите схему в Supabase
2. В панели: Настройки → можно скачать JSON-бэкап (`POST /api/backup`)
3. Перенесите сообщества/посты SQL-или скриптом, когда будете готовы
4. Не удаляйте `data/vkai.sqlite`, пока не сверите число постов и статусы
5. Только после проверки выключайте локальный fallback
