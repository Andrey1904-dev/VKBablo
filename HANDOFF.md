# VKBablo — handoff для Codex

**Актуально на:** 15 октября 2026
**Репозиторий:** `Andrey1904-dev/VKBablo`
**Закреплённая ветка Arena:** `arena/edb22162-vkbablo` — не переключать/не создавать другие ветки; push только в неё.
**База:** `8a66a0e6031e4cf62ba98f924b7d34b220e8b12e`, merge commit PR #11. PR #11 уже merged; эти follow-up исправления надо публиковать отдельным PR из закреплённой ветки.
**Внешние сервисы:** Supabase, VK и AI не подключались. Реальные публикации, платные вызовы и облачные миграции не выполнялись.

## 1. Текущий статус

Задача follow-up аудита — устранить возможность заменить байты одобренного Storage-объекта, разделить owner/editor, ограничить wall photo форматами, которые принимает VK pipeline, и правильно документировать проверку worker/Cron.

Изменения внесены в код, миграции и тесты; их применимость в живой PostgreSQL/Supabase пока не доказана. Свежие установки получают обновлённое описание в базовых migrations; существующую БД обновляют только новые forward migrations:

1. `20261015102000_media_approval_integrity.sql` — digest байтов для approvals/jobs, fail-closed dispatch и запрет overwrite; прежние `approved`/`scheduled` посты возвращаются в `review`.
2. `20261015103000_owner_editor_boundaries.sql` — owner/editor boundaries в RPC/RLS/Storage и Edge routes, защита назначенных ролей.

До развёртывания проверить migration order, старые данные и отсутствие duplicate `(bucket,path)` в `media_assets`. Не применять в production в рамках этой задачи.

## 2. Продукт и неизменяемые решения

- React + TypeScript + Vite; архитектурный путь: GitHub Actions → GitHub Pages → Supabase (PostgreSQL/RLS/Auth/private Storage/Edge Functions/Cron) → VK API и AI adapters. Cloudflare не используется.
- Существуют `demo`, `local` и `supabase` backend implementations за `getBackend()`.
- Целевой продукт — подготовка и управление контентом четырёх VK-сообществ с обязательным ручным одобрением каждой версии. Наличие planner/worker не означает автоматического одобрения или публикации.
- Семантика времени продукта — `Europe/Moscow`, слоты 13:30 / 17:30 / 21:30. Не заменять на `Europe/Warsaw` по местоположению пользователя.
- Правила сообществ, дизайн, маршруты и UI не менять в рамках follow-up. Визуальные правки не нужны.

## 3. Жёсткие ограничения

1. Не подключать реальные сервисы, не вводить ключи, не выполнять платные AI-запросы и ничего не публиковать/удалять в VK.
2. Не менять дизайн, правила сообществ и `Europe/Moscow`.
3. Не класть секреты в Git, Vite env, browser storage, логи или чат. `service_role`, `WORKER_SECRET`, VK/AI keys — только серверное хранилище.
4. Не менять уже применённые миграции после deployment; исправления для существующей БД — отдельная forward migration.
5. Не повторять `wall.post` после unknown result; неизвестный outcome требует ручной сверки с VK.
6. Не считать UI approval достаточным доказательством: hash/version, image bytes, job snapshot и DB dispatch fence должны совпадать.
7. Не сливать PR автоматически в `main`. Сохранить изменения отдельными коммитами, push в закреплённую ветку и открыть новый PR без merge.

## 4. Что изменено в follow-up

### 4.1 Storage и byte integrity

- Upload создаёт новый UUID path с `upsert=false`; edge и local Supabase implementations не перезаписывают объект.
- Удалена authenticated Storage UPDATE policy `media_owner_update`. Owner/editor browser session не может заменить байты по существующему пути.
- `media_assets` хранит SHA-256 и identity metadata `(bucket,path)` защищены уникальностью/immutable trigger.
- Approval сохраняет `approved_image_sha256`; `publication_jobs` фиксирует собственный `image_sha256`. Изменения content/path и изменения объекта обнуляют/инвалидируют approval.
- Publisher скачивает изображение и до `photos.saveWallPhoto`/`wall.post` сверяет байты/SHA-256 с одобренной версией. Изменённые байты при прежнем пути/MIME не могут пройти публикационный путь.
- Forward migration не доверяет старым approvals без byte digest: переводит `approved`/`scheduled` в `review`. Нужно заново загрузить файл и одобрить его.
- Regression checks: `server/tests/publication-safety.test.ts`, `supabase/tests/security_boundaries.sql` и обновлённый `supabase/tests/hash.sql`.

### 4.2 Owner/editor

- `app.is_owner()` — только роль `owner`; `app.is_editor()` — `owner` или `editor`.
- Editor получает разрешённые operational reads/actions. Интеграции/credentials, application/security settings, audit log, профили других людей, owner-only publication/config actions и role assignment закрыты от editor.
- `get_settings()` остаётся owner-only. Прямой `month_spend_usd()` не вызывается authenticated role; `authenticated` не получает доступа к расходам вне owner-guarded ответа.
- Профиль пользователя виден самому пользователю; список профилей — только owner. Browser profile update не может изменить `profiles.role`; это доверенный server-role путь. Отдельного пользовательского management API/UI нет.
- Edge API route map явный и fail-closed для editor: новый/неизвестный route не становится доступен редактору случайно.
- Проверки: `server/tests/authorization.test.ts`, `supabase/tests/security_boundaries.sql`.

### 4.3 Медиа для стены VK

- Для `posts` принимаются PNG/JPEG; uploader и publisher проверяют фактическую сигнатуру, согласованный MIME и расширение. Подмена MIME или неподдерживаемое расширение отвергаются.
- SVG/GIF/WEBP могут применяться там, где generic media/reference workflow их поддерживает, но не могут быть одобрены/отправлены как VK wall photo. Конвертации нет.
- UI picker Post Detail ограничен PNG/JPEG. Проверки: `shared/image-format.ts`, `server/tests/image-format.test.ts` и route/publisher tests.

### 4.4 Worker health и Cron

- Owner-only `Settings → Проверить worker` вызывает API `settings/test-worker`, который отправляет `task=health` с серверным `WORKER_SECRET`.
- Успешный health подтверждает чтение `application_settings`, возвращает `queueTouched:false` и не делает queue claim/planner/generation. Он **не полностью read-only**: worker best-effort пытается записать `worker_run` в `audit_logs`; ошибка записи не отменяет health.
- `cron.job` показывает расписание, `cron.job_run_details` — выполнение SQL команды. Ни то ни другое само по себе не доказывает доставку async HTTP запроса Edge worker-у.
- Runtime evidence: `cron_dispatch` содержит `requestId`; `net._http_response` (если строка сохранилась и доступна) с HTTP 2xx и телом `{ok:true}` подтверждает ответ Edge handler-а; `worker_run` с `details.source='pg_cron'` — дополнительное положительное подтверждение, но audit insert best-effort; `cron_skip` показывает пропуск из-за URL/secret/pg_net config.
- Ни health, ни Cron сейчас не проверялись против настоящего Supabase deployment.

## 5. Основные файлы

- Shared/browser/server policy: `shared/authorization.ts`, `shared/image-format.ts`, `shared/hash.ts`, `shared/publication-safety.ts`.
- Синхронизированная копия для Deno: `supabase/functions/_shared/core/`; проверка drift — `npm run check:shared`.
- Edge worker/API/publisher/storage: `supabase/functions/vk-ai-worker/index.ts`, `supabase/functions/vk-ai-api/index.ts`, `supabase/functions/_shared/{publish,storage}.ts`.
- Локальный backend/tests: `server/storage.ts`, `server/app.ts`, `server/tests/`.
- UI upload: `src/pages/PostDetailPage.tsx`.
- Fresh-install migrations: `supabase/migrations/20261014120000_core_schema.sql`, `20261014120100_rls_policies.sql`, `20261014120200_rpc_functions.sql`.
- Forward migrations: `supabase/migrations/20261015102000_media_approval_integrity.sql`, `20261015103000_owner_editor_boundaries.sql`.
- SQL regressions: `supabase/tests/hash.sql`, `supabase/tests/security_boundaries.sql`, плюс `ai_budget.sql` и `schedule_sync.sql`.
- Operator docs: `CODEX_SETUP.md`, `AUDIT_REPORT.md`, `supabase/README.md`, `.env.example`.

## 6. Проверки и границы доказательств

| Проверка | Результат | Граница |
|---|---|---|
| `npm ci` | PASS | `npm` сообщил о 7 advisories (2 moderate, 5 high); dependency remediation в этот follow-up не входил. |
| `npm test` | PASS, **49/49** | Unit tests/mocks; real services не вызываются. |
| `npm run typecheck` | PASS | Frontend и local Node/server TS; не Edge runtime. |
| `npm run build` | PASS | Vite warning: основной chunk около 730.14 kB (>500 kB). |
| `npm run build:pages` | PASS | Vite warning: основной chunk около 730.23 kB (>500 kB). |
| `npm run check:shared` | PASS, **18 файлов** | Shared и Deno core синхронны. |
| `npx --yes deno check ...` | PASS для двух Edge entry points | Статическая проверка, не Supabase Edge runtime. |
| PGlasT parse | PASS, **17 SQL files** | SQL grammar parse only; не применение SQL и не PL/pgSQL/RLS/ACL runtime. |
| `npm run test:browser` | BLOCKED, **15/15** | Chromium/WebKit binaries отсутствуют; браузерные assertions не исполнились. |
| PostgreSQL/Supabase SQL fixtures | NOT RUN | Нет `psql`, Supabase CLI, `DATABASE_URL` и disposable project. |
| Auth/RLS/Storage/Edge/Cron runtime | NOT RUN | Подключённых сервисов нет. |
| VK / paid AI | NOT CALLED | Намеренно не вызываются. |
| `git diff --check` | PASS | Нет whitespace/conflict-marker ошибок. |

## 7. Следующие действия Codex

1. Прочитать `git status`, весь diff и выполнить `git diff --check`; проверить, что в изменениях нет секретов, изменения TZ или визуального дизайна.
2. Запустить `npm test`, `npm run typecheck`, `npm run build`, `npm run build:pages`, `npm run check:shared`, Edge static type check и доступный SQL parser; записать exit code и ограничения.
3. Не считать PGlasT/PGlite заменой реального PostgreSQL. На отдельном disposable Supabase/Postgres применить миграции по timestamp order и выполнить все `supabase/tests/*.sql`, особенно `security_boundaries.sql` и `hash.sql`.
4. До SQL apply на существующих данных проверить duplicate `(bucket,path)`, а после apply подтвердить invalidation прежних approvals. Не выполнять production rollout в этом задании.
5. Выполнить независимые authenticated-проверки owner/editor: editor не читает settings/integrations/audit/other profiles и не вызывает owner routes; authenticated не может менять role или overwrite Storage object.
6. Сохранить изменения отдельными коммитами, push только в `arena/edb22162-vkbablo`, открыть/обновить PR без слияния в `main`.
7. Передать точный список изменений, commit/PR ссылки и результаты доступных проверок. Явно перечислить остающиеся PostgreSQL/Supabase, Cron runtime, browser/WebKit и live integration tests.

## 8. Локальные команды

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run build:pages
npm run check:shared
git diff --check
npx --yes deno check supabase/functions/vk-ai-api/index.ts supabase/functions/vk-ai-worker/index.ts
```

Для SQL fixtures — только на disposable PostgreSQL и только после ручного review миграций:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/hash.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/ai_budget.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/schedule_sync.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/security_boundaries.sql
```

Подробные этапы развертывания, private Storage проверки и Cron/worker evidence приведены в [`CODEX_SETUP.md`](CODEX_SETUP.md) и [`supabase/README.md`](supabase/README.md). До соответствующего реального теста не утверждать, что cloud setup, worker health или Cron «работают».
