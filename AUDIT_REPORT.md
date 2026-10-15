# VKBablo — follow-up audit: storage integrity, authorization and VK media

**Дата:** 15 октября 2026
**Рабочая ветка:** `arena/edb22162-vkbablo` (сессионная ветка; не переключать)
**Основа:** `8a66a0e6031e4cf62ba98f924b7d34b220e8b12e`, merge commit PR #11. `gh pr view 11` подтвердил, что PR #11 уже `MERGED`; эти follow-up изменения ещё не опубликованы в отдельном PR.
**Ограничения:** реальные Supabase/VK/AI сервисы не подключались; платные AI-запросы и публикации VK не выполнялись; дизайн не менялся.

## 1. Исправления независимого аудита

### 1.1 Одобрение теперь привязано к точным байтам Storage-объекта

**Ранее:** approval хэшировал `image_path`, но не байты. Объект по тому же пути можно было заменить и сохранить прежнее одобрение.

**Изменено:**

- Добавлен `sha256` в `media_assets`, `approved_image_sha256` в `posts` и `image_sha256` в `publication_jobs`.
- `approve_post` принимает только зарегистрированный объект из приватного bucket `media`, проверяет MIME/расширение PNG/JPEG и фиксирует SHA-256 байтовой версии в approval.
- `schedule_post` копирует тот же digest в job; DB dispatch trigger сверяет digest поста, задания и неизменяемых media-метаданных.
- Edge uploader вычисляет SHA-256 с фактических байтов, сохраняет его в `media_assets` и использует `upsert=false`. Локальный Supabase uploader также использует `upsert=false`.
- Удалена Storage policy `media_owner_update`: authenticated owner/editor не могут делать Storage UPDATE/upsert по уже существующему пути. `media_assets` identity fields защищены immutable trigger и уникальностью `(bucket,path)`.
- Перед VK photo upload publisher проверяет фактические байты скачанного объекта, сигнатуру/MIME, расширение и SHA-256 относительно approval/job. Несовпадение останавливает обработку до `photos.saveWallPhoto`/`wall.post`.
- Forward migration переводит прежние `approved`/`scheduled` посты в `review`: старые approvals не содержат доказуемого byte digest и не переносятся автоматически. После миграции потребуется новая загрузка PNG/JPEG и повторное одобрение.
- `server/tests/publication-safety.test.ts` проверяет, что изменённые байты при прежнем пути/MIME/SHA не проходят; `supabase/tests/security_boundaries.sql` проверяет immutable metadata и DB dispatch fence. SQL fixture ещё не запускалась на PostgreSQL.

### 1.2 Owner/editor разделены на Edge, RPC и RLS слоях

- `app.is_owner()` теперь означает только роль `owner`; `app.is_editor()` — `owner` или `editor`. Добавлены `assert_owner` и `assert_editor`.
- Операционные reads и редакционные действия используют роль editor; интеграционные статусы, `application_settings`, аудит, пользовательские профили других людей, security settings, API keys, owner-only publication controls, настройки сообществ и mutations персонажей оставлены owner-only либо service-role-only.
- `get_settings()` проверяет owner. Прямой RPC `month_spend_usd()` отозван у `authenticated`; spend выдаётся только в owner-guarded ответах.
- Dashboard остаётся доступным editor, но скрывает настройки, интеграции и расходы.
- Профиль можно читать самому; список профилей — только владельцу. Роль нельзя изменить из browser profile update: role change разрешён только доверенному server-role пути. Отдельного UI/API для управления пользователями в проекте пока нет.
- `shared/authorization.ts` содержит явный owner-only и editor allowlist. Для editor неизвестный/новый Edge route закрыт по умолчанию; unit test сверяет классификацию со всеми `switch`-case в `vk-ai-api/index.ts`.
- Добавлена forward migration, чтобы уже установленная база получила новое разделение. SQL regression fixture проверяет owner/editor helpers, отказ editor от settings и role-change path; фактическое выполнение ожидает disposable Supabase/PostgreSQL.

### 1.3 Для публикаций принимаются только форматы VK pipeline

- Сигнатура файла сверяется с заявленным MIME; MIME, имя файла и расширение сами по себе не считаются доказательством формата.
- Папка `posts` в локальном/Edge uploader ограничена PNG и JPEG. UI Post Detail предлагает эти форматы. Publisher повторно проверяет MIME, signature и `.png/.jpg/.jpeg` extension.
- WEBP/GIF/SVG по-прежнему доступны только в generic media/reference workflow там, где это нужно; они не могут быть одобрены как VK wall photo. Конвертации нет.
- Добавлены unit tests на spoofed MIME, mismatching signature, неподдерживаемые форматы и расширения.

### 1.4 Worker health и Cron — разные доказательства

- `task=health` читает доступность `application_settings`, не вызывает planner/generation/queue claim и возвращает `queueTouched:false`.
- Это **не полностью read-only запрос**: после health worker best-effort пытается записать `worker_run` в `audit_logs`; ошибка audit insert не отменяет ответ. Вызов требует корректного `WORKER_SECRET`; owner-only API endpoint проверяет тот же контракт.
- `cron.job` доказывает регистрацию расписания. `cron.job_run_details` доказывает запуск SQL-команды Cron, но не подтверждает, что асинхронный `pg_net` HTTP request дошёл и worker завершился.
- Для подтверждения цепочки сверять `audit_logs` (`cron_dispatch`, `worker_run`, `cron_skip`) и `pg_net` response для `requestId`, если таблица ответа доступна. В этой среде Cron не вызывался и фактический запуск не проверен.

## 2. Файлы и миграции

- `shared/image-format.ts`, `shared/hash.ts`, `shared/publication-safety.ts`, `shared/authorization.ts` — общие policy/helpers.
- `supabase/functions/_shared/core/*` — синхронизированная Edge-копия; `npm run check:shared` проверяет drift.
- `supabase/functions/_shared/storage.ts`, `_shared/publish.ts`, `vk-ai-api/index.ts` — Edge upload, публикация и route authorization.
- `server/storage.ts`, `server/app.ts`, `src/pages/PostDetailPage.tsx` — локальный upload policy и file picker.
- `20261014120000_core_schema.sql`, `20261014120100_rls_policies.sql`, `20261014120200_rpc_functions.sql` обновлены для fresh install.
- Новые forward migrations: `20261015102000_media_approval_integrity.sql`, `20261015103000_owner_editor_boundaries.sql`.
- Новые проверки: `server/tests/{authorization,image-format}.test.ts`, обновлён `server/tests/{hash,local-routes,publication-safety}.test.ts`; добавлен `supabase/tests/security_boundaries.sql`; обновлён `supabase/tests/hash.sql`.
- Документы: `CODEX_SETUP.md`, `HANDOFF.md`, `supabase/README.md`, `.env.example` должны соответствовать этому состоянию.

## 3. Проверки этой рабочей копии

| Проверка | Результат | Ограничение |
|---|---|---|
| `npm ci` | PASS | Установлено 226 пакетов; npm сообщил о 7 advisories (2 moderate, 5 high). Полный dependency remediation не входил в эту задачу. |
| `npm test` | PASS, **49/49** | Только локальные unit tests/mocks; VK/AI HTTP не вызывались. |
| `npm run typecheck` | PASS | Frontend и local Node/server TypeScript; не Supabase Edge runtime. |
| `npm run build` | PASS | Vite; основной chunk **730.14 kB**, предупреждение >500 kB. |
| `npm run build:pages` | PASS | Demo Pages build; основной chunk **730.23 kB**, предупреждение >500 kB. |
| `npm run check:shared` | PASS, **18 файлов** | Shared source и Edge core совпадают; это не Deno runtime. |
| `npx --yes deno check supabase/functions/vk-ai-api/index.ts supabase/functions/vk-ai-worker/index.ts` | PASS | Edge static type check; не Supabase Edge runtime/deployment. |
| `pglast` parse | PASS, **17 SQL files** (13 migrations + 4 fixtures) | Проверен внешний SQL grammar, не выполнение PL/pgSQL, grants, RLS или зависимостей в живом Supabase. |
| `npm run test:browser` | BLOCKED, **15/15** | Playwright Chromium/WebKit binaries отсутствуют; browser assertions не стартовали. |
| `git diff --check` | PASS | Нет whitespace/conflict-marker ошибок. |
| PostgreSQL/Supabase SQL fixtures | NOT RUN | Нет `psql`, Supabase CLI, `DATABASE_URL` и disposable project. |
| Supabase Auth/RLS/Storage/Cron/Edge deployment | NOT RUN | Внешний сервис не подключался. |
| VK и paid AI | NOT CALLED | Запрещено текущими ограничениями. |

## 4. Что осталось Codex

1. На отдельной disposable Supabase/PostgreSQL сверить полный порядок миграций; перед apply проверить duplicate `(bucket,path)` в `media_assets`, прежние approvals и in-flight/unknown publication jobs. Не выполнять rollout в production.
2. Применить миграции и выполнить все четыре SQL fixtures (`hash.sql`, `ai_budget.sql`, `schedule_sync.sql`, `security_boundaries.sql`). Отдельно проверить owner/editor RLS/ACL, блокировку role change из authenticated session и отсутствие Storage UPDATE/upsert policy.
3. Фактическая проверка Cron/worker всё ещё не проводилась: сверять `cron.job`, `cron.job_run_details`, `cron_dispatch.requestId`, `net._http_response` (`worker_returned_ok`) и best-effort `worker_run`/изменения job records. Не принимать регистрацию расписания за доказательство исполнения.
4. Playwright 15 browser tests не стартовали из-за отсутствующих Chromium/WebKit binaries; установить браузеры и повторить, если требуется UI smoke. Дизайн не менялся.
5. Не подключать production сервисы, не задавать реальные VK/AI secrets, не выполнять платные запросы/публикации. Проверки сейчас ограничены моками, статической типизацией и SQL grammar parser.

**Итог:** локальные regression tests и сборки проходят, но не заменяют PostgreSQL/Supabase integration. PR #11 уже merged; follow-up должен оставаться отдельным PR из `arena/edb22162-vkbablo` без автоматического merge в `main`.
