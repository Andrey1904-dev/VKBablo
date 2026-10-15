# VKBablo — полный технический аудит и исправления

**Дата:** 15 октября 2026
**Рабочая ветка:** `arena/a5adadd9-vkbablo`
**База:** merge commit `317e660` (PR #10 уже слит в `main`; это проверено через `gh pr view 10`).
**Ограничения проверки:** не заданы реальные Supabase/VK/AI credentials; облачный проект отсутствует; реальные аккаунты, публикации и платные запросы не создавались.

## 1. Краткий вывод

Архитектура сохранена: React/TypeScript/Vite → `getBackend()` → Demo/Local/Supabase implementations; production intent — Supabase Postgres/RLS/Auth/Storage/Edge Functions/Cron. DesignVK не переделывался.

Исправлены несколько опасных/неработающих локальных путей, добавлен атомарный бюджет AI и исправлена синхронизация расписания с состоянием паузы. Это **подготовка**, а не доказательство production-ready облака: миграции не применялись к полному disposable PostgreSQL/Supabase проекту. Обе новые SQL-фикстуры (schedule sync и AI budget) и соответствующие функции отдельно выполнили в PGlite на минимальной локальной схеме; Deno static check обеих Edge Functions прошёл через `npx --yes deno check`. Полные миграции, RLS/Auth/Edge runtime и двухсессионная AI-budget concurrency проверка остаются непроверенными. Поэтому paid AI и real VK должны оставаться выключенными до полноценной интеграционной проверки.

**Подготовка 12 материалов/сутки реализована условно:** planner ставит `full_post` generation jobs для будущих слотов, worker создаёт drafts в `review`. Это не автопубликация; публикация требует отдельного человеческого одобрения актуального хэша. Работа зависит от включённого Cron, Edge secrets, доступности базы и провайдера. Проект не гарантирует 12 готовых или 12 опубликованных материалов при сбое/недоступности интеграции.

## 2. Архитектурный обзор

### React, страницы, маршруты и `getBackend()`

- Вход и маршруты: `src/App.tsx`, `src/bootstrap.ts`, `src/main.tsx`; единая фабрика/синглтон backend: `src/data/index.ts`.
- Страницы: `DashboardPage`, `CommunitiesPage`, `CommunityDetailPage`, `PostsPage`, `PostDetailPage`, `CalendarPage`, `StudioPage`, `CharactersPage`, `AnalyticsPage`, `NotificationsPage`, `SettingsPage`, `LoginPage` (`src/pages/*`).
- Контракты: `src/data/types.ts`; реализации: `src/data/demo.ts`, `src/data/local.ts`, `src/data/supabase.ts`.
- Demo хранит browser-only данные и помечает демонстрационность; Local — Hono + SQLite для разработки; Supabase — authenticated reads по RLS и изменения через RPC/Edge Functions.
- Статическая проверка frontend/server прошла. Browser runtime всех страниц и iPhone layout не подтверждён: Playwright browsers не установлены в среде.

### Backend, база, безопасность и публикации

- Local SQLite migrations: `migrations/0001_init.sql`, `0002_jobs_stats.sql`, новая `0003_safety_reliability.sql`.
- Supabase migrations: `supabase/migrations/20261014120000_core_schema.sql` … `20261014120800_owner_bootstrap_safety.sql`, новые `20261015100000_ai_budget_reservations.sql` и `20261015101000_schedule_sync_safety.sql`.
- RLS/Auth: `supabase/migrations/20261014120100_rls_policies.sql`; RPC: `20261014120200_rpc_functions.sql`; one-time owner bootstrap: `20261014120800_owner_bootstrap_safety.sql`; API/worker: `supabase/functions/vk-ai-api/index.ts`, `supabase/functions/vk-ai-worker/index.ts`.
- Supabase storage: private bucket `media`, signed URLs, upload/delete helpers: `supabase/functions/_shared/storage.ts`; local storage: `server/storage.ts`.
- VK: `supabase/functions/_shared/publish.ts`, `supabase/functions/_shared/vk.ts`; локальный mock/live adapter: `server/vk.ts`.
- Approval: hash и проверка версии в `shared/approval.ts`, `shared/publication-safety.ts`, SQL triggers/RPC. Изменения текста, image path, community или schedule аннулируют approve. VK jobs имеют idempotency key, dispatch fence, unknown-result quarantine и отдельную cancel lifecycle.
- Cron: `supabase/migrations/20261014120400_cron.sql`; worker leases и claim `FOR UPDATE SKIP LOCKED` в RPC/jobs. Local queue в `server/queue.ts` исправлена на durable lease recovery и atomic claim.
- Аналитика строится по фактическим `post_statistics`; демо-данные отдельно помечаются и не должны выдаваться за VK метрики.

## 3. Найденные ошибки и исправления

### P0 — критические

| Проблема | Файлы | Исправление / остаточный риск |
|---|---|---|
| **Local backend мог перейти в `approval` и вызвать реальный `wall.post`, хотя `realPublishEnabled` UI фактически не сохранялся/не проверялся.** В локальном коде не было надёжного DB fence до внешнего VK запроса, поэтому параллельные запросы могли пройти `SELECT` до записи publication job. | `server/posts.ts`, `server/vk.ts`, `server/app.ts`, `src/data/local.ts`, `src/pages/SettingsPage.tsx` | Local режим принудительно test-only; прямой API/UI переход в live отклоняется; schedule блокирует `approval` до VK adapter; токены не принимаются в локальном mock flow. Добавлен regression test, что live mode блокируется до любого VK job/side effect. Supabase остаётся единственным live intent path и не проверен на базе. |
| **Кнопка/route worker health запускала очередь:** `health` не имел отдельной ветки в worker и попадал в `default: tick`, что могло планировать/генерировать материалы при проверке интеграции. | `supabase/functions/vk-ai-worker/index.ts`, `supabase/functions/vk-ai-api/index.ts` | Health теперь делает только DB read и возвращает `queueTouched:false`; неизвестные task отклоняются. API не считает `dispatched`/успехом отсутствие ответа/ошибку worker. Добавлен regression test allowlist. `deno check` обоих entry points — PASS через `npx --yes deno check`; Supabase Edge runtime всё ещё не проверен. |
| **AI monthly budget был только check-then-act:** два worker могли увидеть одну и ту же сумму и одновременно пройти лимит. | новая `supabase/migrations/20261015100000_ai_budget_reservations.sql`; `supabase/functions/_shared/ai.ts`; `server/ai.ts`; `migrations/0003_safety_reliability.sql` | Реализован месячный lock row (`FOR UPDATE`), резерв до каждого paid request, атомарный settlement с `ai_generations`, idempotent settlement. В SQLite добавлены транзакционные резерв/settle. Dry-run дополнительно заблокирован в Edge RPC через `app_mode=test` и server flag. Локальные regression tests и `supabase/tests/ai_budget.sql` на минимальной PGlite-схеме проходят. **Полные миграции и двухсессионный тест на PostgreSQL не запускались — платные вызовы не включать.** Оценка тарифа может отличаться от фактического provider invoice; в таком случае расход способен превысить оценку. Потерянный ответ оставляет резерв активным до операторской сверки. |
| **Одновременный first-owner setup в локальном API мог создать несколько owner аккаунтов:** проверка `userCount()` была вне транзакции. | `server/auth.ts`, `server/app.ts`, `server/db.ts` | `createFirstOwner()` выполняет повторную проверку и запись под `BEGIN IMMEDIATE`, setup latch записывается в той же транзакции. Добавлен тест повторного создания. Supabase bootstrap в предыдущем этапе уже имел DB latch, но реальная Auth транзакция не проверена. |

### P1 — важные

| Проблема | Файлы | Статус |
|---|---|---|
| Slot-only update в `schedules` мог сбросить независимый `communities.status='paused'`: триггер копировал `schedules.paused` в статус сообщества при любом update, включая смену слотов или `skip_until`. | новая `supabase/migrations/20261015101000_schedule_sync_safety.sql`; `supabase/tests/schedule_sync.sql` | Триггер теперь обновляет mirrored status только при insert или фактическом изменении `schedules.paused`; редактирование слотов сохраняет ручную паузу, а `communities.schedule` продолжает синхронизироваться из `schedules.slots`. Rollbackable SQL regression test прошёл в изолированном PGlite fixture. Полная миграция на PostgreSQL/Supabase всё ещё не применялась — повторить тест на disposable проекте перед deployment. |
| Local cancel UI вызывал отсутствующий `/api/posts/:id/unschedule` и получал 404. | `server/app.ts`, `server/posts.ts`, `src/data/local.ts` | Добавлен test-only cancel endpoint, отмена сохраняет состояние, не заявляет о VK delete, сохраняет актуальное approval при неизменном hash. Regression test — pass. Реальный remote cancel остаётся только у Supabase и подтверждается исключительно ответом VK + DB записью. |
| Local jobs со статусом `running` навсегда застревали после падения процесса; claim не был сериализован между процессами. | `server/queue.ts`, `server/db.ts`, `migrations/0003_safety_reliability.sql` | Добавлены stale lease recovery, bounded attempts/dead state, `BEGIN IMMEDIATE` claim, lock token и `busy_timeout`; queue retry повторно запускает только застрявшие `generating/error` слоты, не переобрабатывая `review/approved` content; неизвестные типы jobs более не помечаются успешно. Добавлены recovery/retry/exclusive-claim tests — pass. |
| Characters UI умел загружать, но не одобрять и не выбирать основной reference; Local методы бросали unsupported. | `src/pages/CharactersPage.tsx`, `src/data/local.ts`, `server/app.ts`, `migrations/0003_safety_reliability.sql` | Добавлены owner approve/select controls, endpoint/RPC flow, UUID object paths и local DB состояние; API route regression test загрузки/approval/selection — pass. **Ограничение осталось:** текущие AI adapters честно сообщают `supportsReferences=false` и не передают файлы модели; выбор reference пока не гарантирует визуальное сходство. |
| Pages build всегда задавал `VITE_BACKEND_MODE=demo`, поэтому нельзя было включить Supabase из GitHub Pages variables. | `package.json`, `.github/workflows/pages.yml`, `tests/browser/pages.spec.ts` | Скрипт сохраняет demo по умолчанию, Pages deploy build принимает только публичные variables `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_BACKEND_MODE`. Browser test использует demo artifact; cloud deploy smoke read-only и не создаёт аккаунт. Workflow реально не исполнялся; Pages Source/variables не проверялись. |
| Dry-run paid AI зависел только от default false-флага; при ручном включении server flag можно было вызвать AI и из `app_mode=test`. | `server/ai.ts`, `supabase/functions/_shared/ai.ts`, новая budget migration | Дополнительно требуется `app_mode=approval`; reservation RPC отвергает dry-run независимо от UI/Edge branch. Добавлен local adapter test с mock ключом — тестовый адаптер выбран и сеть не вызывается. PostgreSQL execution ждёт Codex. |
| API upload читал `arrayBuffer()` до ограничения размера и не проверял folder runtime; local VK mock мог сообщать connected/сохранять токен без реальной проверки. | `server/app.ts`, `server/storage.ts` | До чтения проверяются размер, пустой файл, MIME и разрешённая папка; Local VK credentials отклоняются (disconnect разрешён). Supabase upload генерирует UUID и `upsert=false`; same-path replace через официальный API не выполняется. |
| Некоторые чтения страниц проглатывали backend ошибки в `console.error`/пустой state. | `src/pages/AnalyticsPage.tsx`, `CalendarPage.tsx`, `CommunitiesPage.tsx` | Ошибки теперь видны пользователю и есть повтор загрузки; это не проверено browser runtime, только typecheck/build. |

### P1 — не устранено / требуется облачная проверка

1. Все Supabase migrations, Auth triggers, RLS, Storage policies, RPC lock order, Cron и Edge Functions — **не применялись к полному PostgreSQL/Supabase проекту**. Изолированные PGlite fixtures исполнили только две новые AI-budget/schedule migration функции и соответствующие rollbackable SQL tests на минимальных схемах; это не проверяет grants/RLS, всю схему, PostgREST роли, миграционный порядок, Cron или production runtime. Внешний grammar parser сам по себе не проверяет object dependencies и production privileges.
2. Новый AI budget SQL содержит сервисные reserve/settle/release RPC, но `npm run test:ai-budget-concurrency` не запускался: нет `DATABASE_URL`, psql и disposable Postgres. До этого paid AI оставить выключенным. Параметр `actual_usd` — оценка; нужен контроль фактического счёта/тарифа и осторожное ручное восстановление резервов после unknown outcome.
3. Image publisher в Supabase принимает только PNG/JPEG через `fetchRequiredPublicationImage`; upload helper допускает также WEBP/SVG/GIF. Неподдерживаемый формат будет заблокирован до `wall.post`, но интерфейс может позволить загрузить и одобрить его. Конвертер в растр не реализован; для live workflow следует загружать PNG/JPEG. Тестовые SVG illustrations не являются VK-ready изображением.
4. Сходство персонажей не обеспечивается: provider adapter не отправляет references. Настройка/выбор references сохраняется, но не меняет payload текущего OpenAI-compatible image API.
5. Автоматическая подготовка работает только после включения `Cron → worker`; если generation job исчерпал retries, слот с `error` не автоматически возобновляется planner-ом (он не создаёт бесконечную очередь). Нужны мониторинг, ручной retry и правила обработки failed slots.
6. Cron/planner периодически подготавливает будущие slots, не backfill-ит просроченные; missed slots только показываются/учитываются. Это сознательно безопаснее бесконечной генерации.
7. GitHub Pages actual repository source, variables и post-deploy workflow не проверялись. Отдельно подтвердить Settings → Pages → GitHub Actions, затем deploy smoke.

### P2 — улучшения

- `npm run build` и Pages build проходят, но основной JS chunk **730.09/730.17 kB** minified выше Vite 500 kB warning; code splitting не сделан.
- Полный `npm audit` показывает **7 dev-only уязвимостей** в цепочке Tailwind 3.4.19 (`braces`, `chokidar`, `fast-glob`, `micromatch`, `postcss-nested`, `postcss-selector-parser`, `tailwindcss`). `npm audit fix` без major update ничего не исправил; принудительный Tailwind 4 не применялся, чтобы не ломать текущую конфигурацию. `npm audit --omit=dev` — 0 vulnerabilities.
- Локальная Node auth предназначена для dev: login rate-limit in-memory и IP берётся из forwarded header; не экспонировать этот server как production. Production Auth — Supabase Auth.
- Browser tests не прошли запуск: отсутствуют Playwright Chromium/WebKit binaries. Поэтому iPhone 13 visual/overflow test не выполнен, CSS проверен только сборкой/кодом.
- `deno check` для двух Edge Function entry points — PASS через `npx --yes deno check`; Edge runtime и Supabase deployment не запускались.

## 4. Проверки, выполненные в этой рабочей копии

| Проверка | Результат | Граница проверки |
|---|---|---|
| `npm run typecheck` | PASS | frontend + local Node/server TypeScript |
| `npm test` | PASS, **41/41** | Unit tests, mocks only; включает approval, mock VK/AI, budget SQLite, owner latch, interrupted/stale local queue recovery, reference API, worker health allowlist |
| `npm run build` | PASS | Vite; warning chunk >500 kB (730.09 kB) |
| `npm run build:pages` | PASS | Vite Pages demo build; warning chunk 730.17 kB |
| Pages cloud-configured build | PASS | Vite build with placeholder public URL/anon values; no Supabase request was made |
| `node scripts/sync-shared.mjs --check` | PASS, **16 файлов** | shared и Deno-core копия совпадают; не Deno runtime test |
| `node --check scripts/bootstrap-owner.mjs` | PASS | только Node syntax |
| `node --check scripts/test-ai-budget-concurrency.mjs` | PASS | только Node syntax; PostgreSQL не подключён |
| `git diff --check` | PASS | whitespace/conflict checks; повторено после текущих правок перед commit |
| `npm audit --omit=dev --audit-level=moderate` | PASS, 0 | production dependencies только |
| `npm audit` | WARN, 7 dev dependencies | Tailwind 3.x major upgrade нужен для полного исправления |
| pglast parse SQL migrations/tests | PASS, все **14 SQL файлов** (11 migrations + 3 fixtures) | outer SQL grammar only; не заменяет runtime проверки |
| Isolated PGlite SQL regressions | PASS | обе новые миграции и `supabase/tests/{ai_budget,schedule_sync}.sql` на минимальных локальных схемах; не полный Supabase/PostgreSQL migration run |
| `npx --yes deno check supabase/functions/vk-ai-api/index.ts supabase/functions/vk-ai-worker/index.ts` | PASS | статическая проверка двух Edge entry points; не Supabase runtime |
| `npm run test:browser` | NOT RUNNABLE, 15 tests blocked | нет Playwright Chromium/WebKit binaries; assertions не стартовали |
| PostgreSQL full migration/concurrency | NOT RUN | нет psql/DB/DATABASE_URL; PGlite не заменяет две независимые реальных PostgreSQL-сессии |
| Supabase/Auth/RLS/Storage/Cron/Edge/Pages | NOT RUN | проект и secrets не подключены |
| VK/paid AI | NOT CALLED | нет реальных вызовов по ограничениям |

## 5. Точный список дальнейших действий Codex

1. На disposable Supabase создать project и сверить URL/ref.
2. Применить 11 migrations из `CODEX_SETUP.md` в timestamp order после dry-run.
3. Выполнить RLS/Auth checks + `hash.sql` и `ai_budget.sql`; проверить grants/roles.
4. На disposable PostgreSQL запустить конкурентный тест budget reservations (две независимые сессии).
5. Задать secrets в Supabase Dashboard; развернуть `vk-ai-api` и `vk-ai-worker`.
6. Настроить Vault URLs/secrets и Cron; убедиться в read-only health check и фактических запусках.
7. Проверить приватный Storage и signed URL policies.
8. Создать первого owner только через интерактивный `node scripts/bootstrap-owner.mjs`.
9. Проверить тестовый AI backend без внешнего вызова; paid calls оставить off до проверки реального тарифа/budget accounting.
10. Подключить VK токен только после отдельного разрешения, проверить Group ID без публикации.
11. Настроить GitHub Pages repository variables и Source=GitHub Actions; проверить deployed bundle в demo/cloud read-only режиме.
12. Провести ровно одну тестовую публикацию только после отдельного разрешения; проверить `wall.post` результат, затем подтвердить `wall.delete`; не повторять unknown request.
13. Подключать четыре группы по одной, сохраняя 3 MSK slots и ручное одобрение; проверить ошибки/пропущенные slots и budget.

**Итог:** local test/demo и кодовые safety paths готовы к дальнейшему подключению. К облачному production, paid AI и реальным публикациям проект **пока не готов**, пока Codex не выполнит PostgreSQL/RLS/Edge/Cron/Pages integration checklist и конкурентный бюджетный тест.
