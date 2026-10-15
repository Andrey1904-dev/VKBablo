# VKBablo — пошаговая передача Codex

Дата актуальности: 15 октября 2026. Основание: `317e660` (уже слитый PR #10); новые изменения должны оставаться в сессионной ветке `arena/a5adadd9-vkbablo`.

## Жёсткие ограничения

- Не добавлять Cloudflare, не переписывать проект и не переделывать дизайн.
- Не помещать секреты в Git, issue, URL, Vite-переменные, browser storage или логи.
- Не создавать production-аккаунт/владельца без разрешения оператора.
- Не делать реальный `wall.post`, `wall.delete` или платный AI-запрос во время проверки.
- Сохранить ручное одобрение каждой конкретной версии поста.
- `test_mode`/dry-run нельзя считать успешной интеграцией. Миграции и Edge Functions сейчас **не применены и не развёрнуты**.
- Локальный Node/SQLite backend принудительно работает только в test/dry-run. Для real VK предназначен только защищённый Supabase worker.

## 0. Локальные проверки перед настройкой облака

Выполнить из корня репозитория:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run build:pages
node scripts/sync-shared.mjs --check
```

Ожидаемый результат: все команды завершились с кодом 0; `npm test` не вызывает real API. Проверьте, что `.env` игнорируется Git и в `VITE_*` нет service-role key, VK/AI key, `OWNER_SETUP_SECRET` или `WORKER_SECRET`.

## 1. Создать отдельный Supabase project

**Действие:** в Supabase Dashboard создать отдельный проект для тестирования (регион выбрать согласно требованиям владельца), сохранить project ref. Не использовать production DB для первичной проверки.

**Проверка:** открыть Project Settings → API и убедиться, что URL и publishable/anon key принадлежат именно этому тестовому проекту. Service-role key оставить только в защищённом серверном хранилище.

CLI-проверка проекта:

```bash
supabase --version
supabase login
supabase projects list
```

Ожидаемый результат: CLI авторизован интерактивно, нужный project ref присутствует. Не передавать login token в чат или репозиторий.

## 2. Привязать проект и применить миграции по порядку

Из корня репозитория:

```bash
supabase link --project-ref "$SUPABASE_PROJECT_REF"
supabase migration list --linked
supabase db push --dry-run
```

Сверить выбранный project ref и полный план до применения. Требуемый порядок — лексикографический по timestamp:

1. `20261014120000_core_schema.sql`
2. `20261014120100_rls_policies.sql`
3. `20261014120200_rpc_functions.sql`
4. `20261014120300_seed.sql`
5. `20261014120400_cron.sql`
6. `20261014120500_vk_publication_safety.sql`
7. `20261014120600_ai_generation_safety.sql`
8. `20261014120700_generation_mode_safety.sql`
9. `20261014120800_owner_bootstrap_safety.sql`
10. `20261015100000_ai_budget_reservations.sql`
11. `20261015101000_schedule_sync_safety.sql`

Если dry-run показывает неожиданный `DROP`, изменение существующей миграции, иной проект или неизвестный статус — **остановиться** и выяснить причину. Уже применённые миграции не редактировать: последующие исправления — новой миграцией.

После ручного подтверждения target project:

```bash
supabase db push
supabase migration list --linked
```

Ожидаемый результат: миграции `20261014120000`–`20261015101000` отмечены применёнными в том же порядке. Никакие таблицы/данные другого проекта не менялись.

## 3. Проверить PostgreSQL, Auth и RLS

SQL-проверки в SQL Editor или через `psql "$DATABASE_URL"`:

```sql
select tablename
from pg_tables
where schemaname = 'public' and not rowsecurity
order by tablename;

select schemaname, tablename, policyname, roles, cmd
from pg_policies
where schemaname in ('public', 'storage')
order by schemaname, tablename, policyname;

select app.content_hash('stories', 'Проверка', null, now());
```

Ожидаемый результат: у пользовательских таблиц нет неожиданно выключенного RLS; `anon` не имеет прямого доступа; мутации проходят только через ограниченные RPC/Edge проверки. Просмотреть политики `media` отдельно и подтвердить, что bucket приватный. Наличие RLS само по себе не доказывает корректность каждой политики.

Проверки SQL и фикстур:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/hash.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/ai_budget.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/schedule_sync.sql
```

`ai_budget.sql` работает внутри транзакции и откатывает тестовые настройки. Это всё равно надо выполнить на отдельной тестовой БД. Для реальной конкуренции (две независимые PostgreSQL-сессии; только reservation RPC, без AI/VK HTTP) использовать **только disposable БД**:

```bash
DATABASE_URL='postgresql://…' \
VKBABLO_DISPOSABLE_DB_CONFIRM=I_UNDERSTAND \
npm run test:ai-budget-concurrency
```

Скрипт временно меняет `app_mode`, `ai_paid_calls_enabled`, `ai_monthly_limit_usd`, затем восстанавливает их и освобождает только собственные резервы, для которых не было внешнего вызова. Не запускать на production или параллельно с рабочим AI worker.

В Supabase Dashboard → Authentication:

- отключить публичную регистрацию и провайдеры, которые не нужны;
- проверить redirect URL для `https://andrey1904-dev.github.io/VKBablo/`;
- убедиться, что пользователь без профиля/owner роли не получает доступ к owner RPC.

Ожидаемый результат: обычный `anon` не читает данные, зарегистрироваться публично нельзя, роль берётся из серверного профиля, а не из клиентского payload.

## 4. Настроить серверные secrets и создать первого владельца через CLI

В Dashboard → Edge Functions → Secrets задать только необходимые значения: `ENCRYPTION_KEY` (случайные 32+ символа), `WORKER_SECRET` (случайные 32+ символа), `OWNER_SETUP_SECRET` (одноразовый секрет 32–256 символов), `APP_ORIGINS`. `SUPABASE_URL`/service role используются функциями как платформенные серверные значения. Не создавать переменные `VITE_*` для этих секретов.

Деплой функций см. шаг 5. После него запустить на защищённой операторской машине в интерактивном терминале:

```bash
export SUPABASE_URL='https://<project-ref>.supabase.co'
export SUPABASE_ANON_KEY='<public-anon-key>'
node scripts/bootstrap-owner.mjs
```

Скрипт сам запросит email/имя; пароль и setup secret вводятся без отображения. Не передавать их аргументами командной строки. Если есть timeout/unknown outcome — не повторять bootstrap вслепую; сначала сверить Supabase Auth и `public.owner_bootstrap_state`.

Ожидаемый результат: первый профиль создан с ролью `owner`, публичное signup остаётся выключено. Проверить обычный вход через UI и запрос `get_settings()` как владелец. Повторное создание другого владельца должно быть заблокировано.

## 5. Развернуть Edge Functions

```bash
supabase functions deploy vk-ai-api
supabase functions deploy vk-ai-worker
supabase functions list
```

Ожидаемый результат: обе функции `ACTIVE`. `supabase/config.toml` отключает встроенную JWT-проверку для этих функций, поэтому внутри API обязательны свои проверки: JWT профиля/owner и одноразовый bootstrap secret; worker принимает только `WORKER_SECRET`. Не удалять эти проверки и не трактовать `verify_jwt = false` как защиту.

Read-only проверка воркера должна вернуть `ok: true`, `queueTouched: false`; она не должна запускать planner/generation.

## 6. Настроить Cron

Миграция `20261014120400_cron.sql` регистрирует `pg_cron` задания; URL и секрет воркера читаются из Vault (`vk_ai_worker_url`, `vk_ai_worker_secret`). В Dashboard → Vault добавить значения только для своего тестового проекта.

Проверка:

```sql
select jobname, schedule, active, command from cron.job order by jobname;
select * from cron.job_run_details order by start_time desc limit 20;
```

Ожидаемый результат: есть `vk-ai-worker-tick`, `vk-ai-worker-planner`, `vk-ai-worker-publication`, `vk-ai-worker-stats`, `vk-ai-maintenance`, `vk-ai-requeue-stale`; последние запуски без HTTP/auth ошибок. Если `pg_cron`/`pg_net` недоступны, не заявлять об автоматизации: вручную настроить поддерживаемое расписание или оставить функции выключенными.

Система действительно умеет **подготавливать** будущие материалы: planner находит слоты, создаёт `full_post` задачи, worker генерирует статус `review`. Это не означает 12 успешно готовых постов при выключенном Cron, ошибке worker, исчерпанном бюджете или существующем ошибочном слоте. Никакая задача не должна автоматически одобрять публикацию.

## 7. Проверить Storage

Migration создаёт bucket `media` приватным и политики для разрешённых ролей. В Dashboard → Storage проверить:

- bucket `media` существует и `Public bucket` выключен;
- лимит файла 12 MiB;
- signed URL короткоживущие;
- прямой `anon` download не работает;
- upload и signed URL доступны только нужному authenticated/Edge пути.

**Не включать публичность bucket.** Пользовательская загрузка получает новый UUID object path с `upsert=false`; не перезаписывать объект, на который уже ссылается одобренный пост.

## 8. Подключить AI-провайдера безопасно

В начале оставить `ai_provider=test`, `ai_paid_calls_enabled=false`, `app_mode=test`, месячный лимит положительным. Проверить моками:

```bash
npm test
```

Ожидаемый результат: mock transport работает только с `.invalid`, не делает внешних запросов. Секция настроек `Проверить AI` в `test` должна выбрать тестовый движок и не обращаться к платному API.

Для будущего подключения: владелец добавляет серверный ключ через защищённый backend/secret store, проверяет тариф и лимит, затем оператор только после отдельного разрешения может включить платный режим. Перед каждым paid request PostgreSQL `reserve_ai_budget` блокирует текущую UTC budget period; успешный/ошибочный результат фиксируется через `settle_ai_budget`. Потерянный результат оставляет резерв активным и может потребовать ручной сверки со счётом провайдера. **Не освобождать такой резерв только из-за timeout.**

Обязательные проверки до включения: `supabase/tests/ai_budget.sql`, `npm run test:ai-budget-concurrency` на disposable DB, затем ещё раз проверки dry-run. Стоимость остаётся тарифной оценкой, не счётом провайдера; provider может списать больше оценки.

## 9. Подключить VK

Только после успешной RLS/Storage проверки, отдельного разрешения владельца и проверки секретов:

1. Ввести токен сообщества через Supabase UI; он сохраняется сервером в `community_secrets` зашифрованным.
2. Проверить `groups.getById`/соответствие Group ID через отдельную кнопку «Проверить»; токен не должен возвращаться в ответе.
3. Оставить `real_publish_enabled=false` и `app_mode=test` во время функциональных проверок.
4. Не вызывать `wall.post`/`wall.delete` до отдельного разрешения на тестовую публикацию. Local Node backend не подключать к live VK.

Ожидаемый результат на этом шаге — только подтверждённое подключение/проверка группы, не публикация.

## 10. Проверить dry-run и ручное одобрение

На тестовом Supabase проекте:

- оставить `app_mode=test`, `real_publish_enabled=false`, AI paid calls выключенными;
- подготовить один ближайший тестовый слот;
- убедиться, что результат `review`, `approved_hash IS NULL`, `test_mode=true` для mock generation;
- проверить, что `schedule_post` возвращает `dryRun=true`, а publication job имеет `dry_run=true` и `test_…` ID;
- изменить текст/изображение/время — хэш/одобрение должны сброситься;
- нажать worker health — `queueTouched=false`, generation queue не меняется;
- отменить test/dry-run слот и проверить его статус в БД.

Ожидаемый результат: dry-run не делает запросов к VK и платному AI, неподтверждённая или изменённая версия не публикуется.

## 11. Настроить GitHub Pages на облачный backend

Сначала в репозитории GitHub → Settings → Pages → Source выбрать **GitHub Actions**.

В Settings → Secrets and variables → Actions → **Variables** добавить только публичные:

- `VITE_SUPABASE_URL` = project URL;
- `VITE_SUPABASE_ANON_KEY` = publishable/anon key;
- `VITE_BACKEND_MODE` = `auto` (или `supabase` после отдельной проверки).

Это публичные значения: URL и anon key попадут в JavaScript. Service role, `OWNER_SETUP_SECRET`, `WORKER_SECRET`, encryption key, AI/VK tokens туда не помещать. Workflow сначала собирает изолированный demo для безвредного browser smoke, а артефакт deploy собирает с public variables; без variables `auto` остаётся demo. `local` не подходит для Pages.

После push в `main` проверить Actions run `Deploy demo frontend to GitHub Pages`, Pages URL и HTML `meta[name=vkbablo-build]`. Deploy smoke при cloud backend должен оставаться read-only и не создавать пользователя. Проверить RLS, login screen и отсутствие запросов к API до авторизации.

## 12. Проверить одну тестовую публикацию — только после отдельного разрешения

Этот шаг запрещён без отдельного письменного разрешения владельца. Никакие инструкции выше не дают разрешение на реальный VK side effect.

Сначала сделать один тестовый post в тестовом сообществе, выставить время вперёд, пройти вручную approve и перепроверить hash + image. Только оператор после проверки может временно включить `app_mode=approval` и `real_publish_enabled=true`; подтвердить ровно один `wall.post`, сохранить returned VK post ID, затем проверить `wall.delete` на этой тестовой записи и выключить оба флага. Не повторять `wall.post` при timeout/unknown result.

Проверка результата: в `publication_jobs` один `done` job, совпадают `post_id`, `version_hash`, target group, `vk_post_id`; аудит содержит одобрение владельца и успешное завершение. Unknown result означает ручную сверку с VK, не retry.

## 13. Подключить четыре основные сообщества

Только после успешного тестового цикла и отдельного подтверждения владельца подключать по одному:

1. «Ну и история» (`stories`)
2. «Милана и её деревенский гламур» (`milana`)
3. «ВСЯ СУТЬ ЖИЗНИ» (`life`)
4. «Вероника в поиске настоящего мужчины» (`veronica`)

Для каждого сверить Group ID, токен, график 13:30 / 17:30 / 21:30 `Europe/Moscow`, `automation_enabled`, лимиты и ручной approval. Ожидаемая номинальная ёмкость — 3 слота × 4 сообщества = 12 заданий подготовки в сутки. Это **не гарантия 12 опубликованных постов** и не разрешение на автопубликацию.

## Финальный checklist Codex

```bash
npm run typecheck
npm test
npm run build
npm run build:pages
node scripts/sync-shared.mjs --check
node --check scripts/bootstrap-owner.mjs
npm run test:ai-budget-concurrency   # только disposable PostgreSQL, с явным confirmation
```

Проверить Edge types статически:

```bash
npx --yes deno check supabase/functions/vk-ai-api/index.ts supabase/functions/vk-ai-worker/index.ts
```

Ожидаемый результат: обе функции проходят Deno type check; это **не** запуск в Supabase Edge runtime. Для SQL: применить миграции к отдельному PostgreSQL/Supabase проекту и выполнить integration SQL; `pglast`/PGlite ограниченные fixtures не заменяют проверку всей схемы, grants/RLS и конкурентных транзакций. В финальном отчёте явно перечислить непроведённые PostgreSQL, Edge runtime, browser/WebKit и внешние API проверки.
