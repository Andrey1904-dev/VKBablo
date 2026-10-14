# VK AI Manager — передача проекта (handoff для следующего агента)

Документ описывает **фактическое состояние репозитория** по состоянию на HEAD ветки
`arena/828b3734-vkbablo` (коммиты `83dda89` → `e9c3616` → `1217f92`): что сделано, что нет,
какие контракты нельзя ломать, что уже проверено, а что ещё нигде не запускалось.

Читать целиком перед первой правкой. Всё, что не описано здесь как «проверено», —
**не проверено** и не должно называться работающим.

## 0. Сводка в десяти строках (для быстрого старта)

1. Репозиторий `Andrey1904-dev/VKBablo`, рабочая ветка **`arena/828b3734-vkbablo`**,
   текущие коммиты: `83dda89` (тег `checkpoint/pre-supabase-migration`) → `e9c3616` → `1217f92`.
2. Cloudflare полностью удалён; целевая архитектура — GitHub Pages (frontend) + Supabase
   (Postgres/RLS/Auth/Storage/Edge Functions/Cron) + VK API + сменные AI-адаптеры.
3. Код этапов 2, 3 и половины 4 написан: 5 миграций (27 таблиц, 35 RPC, RLS, сиды, Cron),
   Edge Functions `vk-ai-api` (34 маршрута) и `vk-ai-worker`, слой данных фронтенда
   `src/data/*` (режимы supabase / local / demo).
4. **Ничего из облачного контура ещё не запускалось**: миграции не применялись, функции не
   деплоились, ключей нет, реальные VK-вызовы и платные AI не выполнялись. Тарифы и лимиты
   не подтверждены.
5. Проверено локально: `npm run typecheck` (чисто), `npm test` (11/11), `npx vite build`,
   синхронизация ядра `--check`, живой смоук локального стенда (одобрение обязательно,
   правка сбрасывает одобрение).
6. Следующая главная задача — **этап 4**: перевести 14 файлов (12 страниц + `App.tsx` +
   `components/layout.tsx`) с прямых вызовов `@/lib/api` на `getBackend()` из `@/data`,
   **не меняя дизайн**. Готовая таблица соответствия вызовов — в §8.2.
7. Затем: `CODEX_SETUP.md` + workflow публикации на GitHub Pages (этап 9), интеграционные
   тесты на реальном Supabase (этап 8), доработки студии/календаря (этапы 5–6), отчёт (этап 10).
8. Ни при каких условиях: не включать реальную публикацию в VK, не вызывать платные API,
   не выдавать демо-данные за настоящие, не менять правила четырёх сообществ, не возвращать
   Cloudflare, не ломать канонический хэш одобрения (§7.1).
9. Карта кода — §6, контракты — §7, самые частые грабли и уже исправленные ошибки — §11:
   читать до первой правки, там объяснено, почему некоторые «очевидные» улучшения запрещены.
10. Всё, что не помечено в §9 как проверенное, нельзя называть работающим.

---

## 1. Что это за проект

Автономная платформа управления четырьмя сообществами ВКонтакте: генерация текстов и
изображений, **обязательное ручное одобрение каждой публикации**, отложенная публикация
по расписанию 13:30 / 17:30 / 21:30 (Europe/Moscow) × 4 сообщества = 12 постов в сутки,
аналитика только по фактически опубликованным данным, полная память по каждому сообществу.

Сообщества (правила, темы, стиль — **менять нельзя**, они согласованы владельцем):

1. `stories` — «Ну и история» (байки/истории, первое лицо);
2. `milana` — «Милана и её деревенский гламур» (Милана + Толечка);
3. `life` — «ВСЯ СУТЬ ЖИЗНИ» (без ложных утверждений и искусственного возмущения);
4. `veronica` — Вероника, 38 лет (город не называется никогда, если владелец явно не разрешил).

Целевая архитектура (утверждена, менять нельзя):

```
GitHub (исходники)  →  GitHub Actions  →  GitHub Pages (React + Vite, hash-роутинг)
                                           │  публичный anon-ключ + RLS
                                           ▼
                     Supabase: PostgreSQL (схема + RLS + RPC) + Auth + Storage (private)
                               + Edge Functions (vk-ai-api, vk-ai-worker) + Cron (pg_cron + pg_net)
                                           │
                                           ▼
                                   VK API (community token) и AI-провайдеры (адаптеры)
```

**Cloudflare полностью исключён**: нет Workers, D1, R2, Wrangler, `wrangler.toml`,
`bindWorkerEnv`. Не возвращать ни под каким предлогом.

---

## 2. Где мы находимся: репозиторий, ветка, коммиты

- Репозиторий: `Andrey1904-dev/VKBablo` (локально `/home/user/VKBablo`).
- Рабочая ветка: **`arena/828b3734-vkbablo`** (в этой сессии работать только в ней).
- Коммиты:
  - `83dda89` — исходное состояние (merge PR #1), на него поставлен тег
    **`checkpoint/pre-supabase-migration`**;
  - `e9c3616` — «Миграция на Supabase: Cloudflare снят, схема БД, Edge API и слой данных»
    (69 файлов, +13167/−602). Это текущее состояние, рабочее дерево чистое.
- Отдельной «ветки миграции», как просил владелец, пока нет: работа идёт в
  `arena/828b3734-vkbablo`, чекпоинт зафиксирован тегом. Если потребуется — создать ветку
  от `83dda89` и перенести туда коммит `e9c3616` (или смержить тег), но **не переключать
  эту сессию на другую ветку**.
- Локальный стенд в песочнице мог остаться запущенным: `npm run dev` (web :5173, api :8787).
  Проверить: `curl -s http://127.0.0.1:8787/api/health`.

---

## 3. Жёсткие ограничения (нарушение = провал задачи)

Из ТЗ и прямых указаний владельца:

1. **Не начинать заново.** Сохранять существующий дизайн, компоненты, маршруты, бизнес-логику
   и историю Git. Архитектурные изменения — только без потери работающей функциональности.
2. **Cloudflare исключён** полностью.
3. **Никаких реальных ключей и платных вызовов на этом этапе**: не требовать VK/AI/Supabase
   ключей, не вызывать платные API, не публиковать в VK. Ключи владелец подключит позже сам
   по документу `CODEX_SETUP.md` (его ещё надо написать).
4. **Секреты не попадают в Git, в браузер, в логи, в localStorage и в чат.**
   В клиентском коде допустимы только `VITE_SUPABASE_URL` и `VITE_SUPABASE_ANON_KEY`
   (publishable/anon — безопасен при включённом RLS). `service_role`, VK-токены и AI-ключи —
   только серверное окружение Supabase.
5. **Обязательное ручное одобрение.** Ни одна публикация не уходит в VK без явного одобрения
   владельцем конкретной версии текста+картинки+сообщества+времени; любое изменение сбрасывает
   одобрение; глобальный тумблер «Реальные публикации VK разрешены» по умолчанию **выключен**
   и не отменяет ручное одобрение.
6. **Правила четырёх сообществ не менять** (18+/эротика/обнажённость запрещены; у Вероники не
   называть город; «ВСЯ СУТЬ ЖИЗНИ» без ложных фактов; для milana обязательно упоминание Миланы;
   AI не должен выдумывать конкурентный анализ без исходных данных).
7. **Не придумывать внешность персонажей.** Пока нет реальных фото — только заглушки
   (`appearance_status = 'placeholder'`), честные ограничения генератора (отсутствие identity-lock)
   показывать в интерфейсе, а не обещать «идеальное сходство».
8. **Не выдавать демо/тестовые данные за реальные.** Тестовые публикации помечаются
   `test_mode = true` и `vk_post_id = test_*`, демонстрационная аналитика — `source: 'demo'`,
   интеграции без ключей показываются как `off`/`demo`, а не «подключены».
9. **Не делать статистических выводов при малых данных** (`insufficientData`, порог 12 постов).
10. **Долгие задачи — только асинхронными заданиями** (очереди + воркер + восстановление), а не
    долгим выполнением одного HTTP-запроса: у Edge Functions ограниченное время жизни.
11. **Развёртывание не должно требовать постоянно включённого MacBook** — GitHub Pages + Supabase
    работают без локальной машины.
12. **Интерфейс на русском**, светлая и тёмная темы, приоритет — iPhone и MacBook.
13. **Не заявлять, что облако проверено, если оно реально не запускалось.** Сейчас не запускалось.
14. **Проверять актуальные лимиты VK API** (в т.ч. отложенную публикацию `publish_date`) до
    включения реального режима.
15. **Проверить, что Cron реально работает на выбранном тарифе Supabase** до включения
    автоматизации.

---

## 4. Статус по 10 этапам ТЗ

| № | Этап | Статус | Что именно сделано / чего не хватает |
|---|---|---|---|
| 1 | Аудит и план | ✅ готово | `AUDIT.md` + тег `checkpoint/pre-supabase-migration` |
| 2 | Cloudflare → Supabase | ✅ в коде | `wrangler.toml`, `server/worker.ts`, `bindWorkerEnv` удалены; документация очищена; Edge-слой написан и лежит в `supabase/functions` |
| 3 | БД + безопасность | 🟡 код есть, **не применён** | 5 миграций (27 таблиц, 35 RPC, RLS, сиды, Cron), `supabase/config.toml`, `supabase/tests/hash.sql`; ни одна миграция ещё не выполнялась — нет ни локального Postgres, ни проекта Supabase |
| 4 | Интерфейс (слой данных + сохранение дизайна) | 🟡 наполовину | слой данных `src/data/*` + `src/lib/config.ts` готовы и проходят typecheck; **страницы ещё не переведены** на него — 12 страниц, `App.tsx` и `components/layout.tsx` по-прежнему зовут `@/lib/api` напрямую |
| 5 | Контент-движок | 🟡 в коде | тестовый детерминированный движок `shared/content-engine.ts`, правила и проверки `shared/rules.ts`, `similarity.ts`, AI-адаптеры `_shared/ai.ts` (test/openai/compatible/custom) с учётом расходов; реальный провайдер не проверялся (ключей нет) |
| 6 | Планировщик | 🟡 в коде | `_shared/jobs.ts`, `_shared/publish.ts`, `vk-ai-worker`, RPC очередей, Cron-задачи; **ничего из этого не запускалось** (Postgres нет). Локальный стенд имеет собственный таймер/очередь и проверен вживую |
| 7 | Интеграции VK + AI | 🟡 в коде | `_shared/vk.ts` (группа, загрузка фото, отложенная запись, статистика, ошибки), `_shared/ai.ts` (адаптеры, бюджеты), `_shared/secrets.ts` (AES-256-GCM), `_shared/storage.ts`; реальные вызовы VK не выполнялись, лимиты VK не верифицированы |
| 8 | Тестирование | 🟡 частично | `npm run typecheck` — чисто, `npm test` — 11/11 (одобрение + хэш версий), `npx vite build` — ОК, `sync-shared --check` — ОК, живой смоук локального стенда; **нет** интеграционных тестов против реального Supabase/VK/AI |
| 9 | Развёртывание | ❌ не начато | есть CI (`.github/workflows/ci.yml`), **нет** workflow публикации на GitHub Pages, нет `CODEX_SETUP.md`, нет проверки секретов на pre-deploy |
| 10 | Итоговый отчёт | ❌ не начато | шаблон требований — в разделе 12 |

Легенда: ✅ сделано и проверено · 🟡 код есть, но не проверено в реальной среде · ❌ не сделано.

---

## 5. Как система работает целиком (важно понимать до правок)

1. **Фронтенд** (GitHub Pages) общается с Supabase двумя способами:
   - **чтение** — PostgREST под RLS (пользователь видит только то, что разрешает политика);
   - **изменения** — Edge Function `vk-ai-api` (проверяет JWT, роль и вызывает RPC).
2. **Пароль/сессии** — Supabase Auth. Первый вход: одноразовое создание владельца через
   `vk-ai-api/bootstrap/owner` (публичный маршрут, но работает только пока в `profiles` пусто).
3. **Контент** генерируется заданиями `generation_jobs`: планировщик создаёт заготовку поста
   (`status = 'generating'`) и задание с идемпотентным ключом
   `gen:<community>:<UTC YYYYMMDDHHMI>:<kind>`. Воркер забирает задание, собирает контекст
   (правила сообщества, персонажи, ограничения провайдера, недавние тексты для антидубля),
   вызывает адаптер, пишет результат в пост (`status = 'review'`) и в `ai_generations`
   (промпт, модель, стоимость, ошибка).
4. **Одобрение** — RPC `approve_post`: считает канонический хэш и записывает его в
   `approved_hash` (при одобрении хэш обязан совпасть с `content_hash`). Любая правка текста /
   картинки / времени / сообщества сбрасывает `approved_hash` триггером `app.posts_sync_hash`,
   переводит пост в `review` и принудительно включает `test_mode = true`.
5. **Планирование** — RPC `schedule_post` (минимум 60 секунд до слота) создаёт задание
   `publication_jobs`; реальная отправка возможна только при выполнении **трёх** условий
   одновременно: `app_mode = 'approval'`, `real_publish_enabled = true`, пост не в `test_mode`
   и одобрение не сброшено. Иначе воркер выполняет симуляцию и ставит `vk_post_id = test_*`.
6. **Публикация** — воркер (`publish_due`) вызывает VK `wall.post` с `publish_date` (отложенная
   запись), при ошибке — backoff и повтор; занятые задания захватываются транзакционно
   (`claim_publication_job`), а `finish_publication_job` фиксирует результат.
7. **Статистика** — задача `stats` собирает метрики по опубликованным постам (`post_statistics`,
   `source = 'vk'`), аналитика строится только из фактических данных, при малом объёме
   показывается `insufficientData`.
8. **Cron** (в базе, `pg_cron` + `pg_net`) дёргает воркер: `tick` каждые 5 минут, планировщик
   в 15 минут каждого часа, публикация каждые 2 минуты, статистика каждые 3 часа, обслуживание
   в 00:35, переочередь зависших заданий каждые 20 минут. Если URL воркера или секрет не заданы —
   шаг пропускается и пишется запись в `audit_logs` (никаких падений).
9. **Локальный стенд** (`server/`, Hono + `node:sqlite`) — только для разработки: тот же UI,
   свои `data/vkai.sqlite` и `data/uploads`. Он не production и не должен подменять облако.

---

## 6. Карта кода

### 6.1 `shared/` — изоморфное ядро (используется браузером, Node и Deno)

| Файл | Содержимое |
|---|---|
| `types.ts` | все доменные типы: `PostStatus` (9 статусов), `Community`, `Post`, `Character`, `ApplicationSettings`, `DashboardData`, `AnalyticsPayload`, `BackendKind` и т.д. |
| `hash.ts` | **канонический хэш версии** (см. §7.1), `normalizeText`, `canonicalUtc`, `shortHash` |
| `moscow.ts` | `MOSCOW_TZ`, `DEFAULT_SLOTS` (`13:30/17:30/21:30`), `moscowParts`, `moscowSlotIso`, `addDays`, `normalizeSlots`, `formatMoscow`, `upcomingSlots`, `missedSlots`, `slotKey`, `toDatetimeLocalMoscow`/`fromDatetimeLocalMoscow` |
| `approval.ts` | `APPROVABLE_STATUSES` (`draft`, `review`, `needs_revision`, `approved`), `canApprove` (нужны текст + изображение + время), причина сброса одобрения при изменении текста/картинки/времени/сообщества |
| `rules.ts` | проверки текста: 18+/токсичное = ошибка, тема города Вероники, обязательное упоминание Миланы, цифры и проценты без пометки в «ВСЯ СУТЬ ЖИЗНИ», длина 120–1800 символов |
| `similarity.ts` | антидубль: 0.28 — «похоже», 0.7 — блокирующая остановка генерации |
| `prng.ts` | детерминированный PRNG (`mulberry32`, `seedFrom`, `uid`) — одинаковые результаты при одинаковом seed |
| `content-engine.ts` | тестовый контент-движок: `Idea`, серии для каждого сообщества, `generateIdea(s)`, `generateText`, `titleForTopic`; **явно помечен как НЕ языковая модель** |
| `constants.ts` | `COMMUNITY_META`, `STYLE_RULES`, `COMMUNITY_RULE_SETS` v1 (согласованные правила владельца), `DEFAULT_AI_PROVIDERS`, `DEFAULT_AI_PROMPTS`, `APP_LIMITS`, `DEFAULT_APP_SETTINGS`, `DEFAULT_GENERATION`, `DEMO` |
| `demo-image.ts` | детерминированные SVG-иллюстрации (data URL) для демо-режима и локального стенда |

> `supabase/functions/_shared/core/*` — **копия** `shared/*`, создаваемая скриптом
> `node scripts/sync-shared.mjs`. Руками её не править. После любой правки в `shared/`
> запускать синхронизацию, иначе CI упадёт на `--check`.

### 6.2 `supabase/` — серверная часть

- `config.toml` — порты CLI, Storage 12 МиБ, Auth (site_url GitHub Pages, регистрация выключена),
  `verify_jwt = false` у обеих функций (они проверяют JWT/секрет сами).
- `migrations/20261014120000_core_schema.sql` — 27 таблиц, индексы, CHECK-ограничения, триггеры,
  функции `app.*` (`content_hash`, `assert_owner`, `log_audit`, `get_setting`, `is_owner`,
  `posts_sync_hash`, `handle_new_user`, `schedules_sync_communities`), бакет `media`, Realtime.
- `migrations/20261014120100_rls_policies.sql` — RLS: владелец/редактор только чтение,
  `anon` отозван, удаления только service role, отсутствие политик у `community_secrets`.
- `migrations/20261014120200_rpc_functions.sql` — **35 RPC**. Ключевые:
  `create_manual_post`, `save_post_edit`, `approve_post`, `reject_post`, `request_revision`,
  `schedule_post`, `unschedule_post`, `enqueue_generation`, `enqueue_upcoming_generations`,
  `enqueue_regeneration`, `claim_generation_job`, `finish_generation_job`, `requeue_stale_jobs`,
  `claim_publication_job`, `finish_publication_job`, `posts_due_for_publication`,
  `mark_post_published`, `posts_due_for_stats`, `save_post_statistics`, `update_community`,
  `save_community_rules`, `save_character`, `add_character_reference`, `set_primary_reference`,
  `approve_character_reference`, `delete_character_reference`, `save_settings`, `get_settings`,
  `month_spend_usd`, `set_integration_status`, `mark_notifications_read`, `import_analytics`,
  `missed_slots`, `analytics_overview`, `dashboard_overview`.
- `migrations/20261014120300_seed.sql` — 4 сообщества, слоты, правила v1 + история версий,
  3 персонажа-заглушки, AI-провайдеры, `integration_status`, предохранители
  (`app_mode = test`, `real_publish_enabled = false`, `ai_paid_calls_enabled = false`).
- `migrations/20261014120400_cron.sql` — 6 задач `cron.schedule` + защита: если нет
  vault-секрета `vk_ai_worker_url`/`vk_ai_worker_secret` либо расширения `pg_net`, шаг
  пропускается с записью в `audit_logs`.
- `functions/_shared/*` — серверное ядро: `env.ts` (все секреты и origin-политика),
  `http.ts` (`ApiError`, CORS, `json`, `errorResponse` с маскировкой `sk-`/`vk1.`/JWT,
  `readJson`, `requireString`, `optionalString`, `assertIso`), `db.ts` (`admin`, `asUser`,
  `callRpc`, `requireUser`), `crypto.ts`, `secrets.ts` (AES-256-GCM для VK-токенов и AI-ключа),
  `storage.ts` (bucket `media`, папки, signed URL), `images.ts` (`illustrationPrompt`,
  `assertVkCompatibleImage` — **отвергает SVG**), `ai.ts` (адаптеры + `paidGuard`/`budgetGuard`),
  `vk.ts` (клиент VK), `jobs.ts` (общие помощники очередей), `context.ts` (правила + персонажи +
  недавние тексты), `references.ts` (только одобренные референсы, 30-минутные signed URL),
  `publish.ts` (процесс публикации, `collectStatistics`, `markDuePostsPublished`).
- `functions/vk-ai-api/index.ts` — 34 маршрута в `switch` + 3 вне него (`health`, `setup-state`,
  `bootstrap/owner`): `health/auth`, `integrations/status`, `posts/*` (create, edit, approve,
  reject, revise, schedule, unschedule, regenerate, generate), `planner/prepare`, `worker/run`,
  `communities/{update,rules,vk-token,vk-check}`, `characters/{update,references,
  references/primary,references/approve,references/delete,readiness}`,
  `ai/ideas`, `settings/{save,ai-key,test-ai,test-worker}`, `media/{upload,sign,delete}`,
  `image-prompt`, `analytics/import`, `notifications/read`.
- `functions/vk-ai-worker/index.ts` — задачи `tick` (по умолчанию), `planner`, `publish_due`,
  `stats`, проверка работоспособности; константное сравнение `x-worker-secret`, бюджет времени
  ~45 секунд, не более 2 заданий за запуск, `requeue_stale_jobs`, учёт `automationPaused`,
  запись в `audit_logs`.
- `tests/hash.sql` — сверка `app.content_hash` с тремя эталонными векторами и проверка
  инварианта «правка текста сбрасывает одобрение».
- `README.md` — состав, порядок миграций, инварианты, секреты, Storage, Realtime, проверки.

### 6.3 `server/` — локальный стенд (только для разработки)

Hono API на `node:sqlite`, порт 8787: `app.ts` (~651 строка, 46 маршрутов `/api/*`),
`posts.ts` (логика постов и версий), `ai.ts`, `content.ts`, `images.ts`, `similarity.ts`,
`vk.ts` (dry-run), `storage.ts`, `notify.ts`, `queue.ts`, `db.ts`, `env.ts`, `lib.ts`
(`requireParam`, `contentHash` делегирует в `shared/hash.ts`), `auth.ts`, `index.ts`,
`seed.ts`, тесты в `tests/` (`approval.test.ts`, `hash.test.ts`).

**Не возвращать** `server/worker.ts` и `bindWorkerEnv` — удалены в этапе 2.

### 6.4 `src/` — фронтенд

- `lib/config.ts` — конфигурация: `CONFIG.backend` (`supabase | local | demo`, режим `auto`
  по умолчанию: Supabase при наличии публичных ключей, иначе демо), `useHashRouter`
  (по умолчанию true — нужен для GitHub Pages), ключи localStorage.
- `lib/api.ts` — тонкий fetch-клиент локального API (`ApiError`, `api<T>()`, цвета статусов).
- `data/types.ts` — интерфейс `Backend` (полный список методов) + `CommunityDetail`,
  `VkConnectResult`, `GenerateSlotInput`, `backendInfoFor`.
- `data/demo.ts` — `DemoBackend`: полностью автономный режим в браузере (localStorage
  `vkai-demo-store-v2`), честные ошибки вместо невозможных действий, `test_*` идентификаторы.
- `data/local.ts` — `LocalBackend`: обёртка над `/api/*`, облачные операции бросают
  `unsupported()` со ссылкой на `CODEX_SETUP.md`.
- `data/supabase.ts` — `SupabaseBackend`: чтение PostgREST под RLS, изменения через
  `vk-ai-api`, RPC `dashboard_overview`/`get_settings`/`analytics_overview`, подписанные ссылки
  с кэшем на 50 минут, Realtime на `posts`/`notifications`/`publication_jobs`/`generation_jobs`,
  `waitForGeneration` (по таймауту честно возвращает статус `generating`).
- `data/index.ts` — `createBackend()` / `getBackend()` / `peekBackend()` / `resetBackend()`.
- `pages/*` (12 страниц), `components/{ui,layout}.tsx`, `App.tsx` — **пока на `@/lib/api`**,
  это и есть основная работа этапа 4 (§8).

### 6.5 Инфраструктура и документация

- `scripts/sync-shared.mjs` — копирование `shared/*` → `_shared/core/` с заголовком
  «сгенерировано», режим `--check` для CI, запрет `node:`/Deno/`process`/`require` в ядре.
- `.github/workflows/ci.yml` — checkout → Node 22 (кэш npm) → `npm ci` → sync-shared `--check`
  → `npm run typecheck` → `npm test` → `npm run build`.
- `.env.example` — полностью переписан: локальный стенд, публичные `VITE_*`, серверные секреты
  Supabase, заготовки VK/AI, правила безопасности.
- `.gitignore` — `.env*`, `data/` (**именно `/data`**, иначе пострадает `src/data/`),
  `dist`, `uploads`, `*.sqlite`, `.supabase`, `supabase/.temp`.
- `README.md` — обзор + «Деплой: GitHub Pages + Supabase» (Cloudflare упомянут только как
  «не используется»).
- `AUDIT.md` — этап 1: инвентаризация, план миграции, риски.
- `HANDOFF.md` — этот файл.

---

## 7. Контракты, которые нельзя ломать

### 7.1 Канонический хэш версии (основа одобрения)

```
sha256(
  communityId + "\n" +
  btrim(text с заменой CRLF→LF) + "\n" +
  coalesce(image_path, '') + "\n" +
  to_char(scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)
```

Реализации: `shared/hash.ts` (`contentHash`) и SQL `app.content_hash`.
Тождественность подтверждена тестом против `node:crypto` на трёх векторах, те же векторы —
в `supabase/tests/hash.sql`. **Менять алгоритм нельзя**: иначе сбросятся все одобрения и
разъедется JS/SQL. Правила поведения: правки «косметики» (пробелы по краям, CRLF→LF, тот же
момент времени в другом часовом поясе) одобрение **не** сбрасывают; изменение текста,
картинки, времени или сообщества — сбрасывают.

### 7.2 Инварианты одобрения (на уровне БД, а не UI)

- `posts_approval_matches_hash`: `approved_hash is null or approved_hash = content_hash`.
- `posts_scheduled_requires_approval` и `posts_published_requires_approval`.
- Триггер `app.posts_sync_hash` при материальном изменении: `approved_hash = null`,
  `approved_at/approved_by = null`, статус `approved`/`scheduled` → `review`, `test_mode = true`.
- Уникальные частичные индексы: один пост на слот (`community_id, scheduled_at`) и защита от
  дублей по хэшу контента.
- `vk_ai_api` не может обойти эти правила: любой путь изменений идёт через RPC.

### 7.3 Edge API: формат ответов и ошибок

- Успех: JSON тела (`200`/`201`), CORS только для разрешённых origin (`APP_ORIGINS`,
  localhost/127.0.0.1, `*.e2b.app`).
- Ошибка: `{ "error": "<русский текст>", "code": "<код>" }`; статусы `400` (валидация),
  `401` (нет/истёк JWT), `403` (роль/owner-only), `409` (дубли), `413` (файл > 12 МБ),
  `429` (лимиты: 30 в минуту на посты, 10 на одобрения, 20 на генерацию), `500`.
- Клиент читает ошибку из `error.context` (это `Response`) — см. `functionsError` в
  `src/data/supabase.ts`.
- Секреты в ответах не появляются: только факт наличия ключа/подсказка последних символов.

### 7.4 Что возвращают ключевые RPC (используется фронтендом)

| RPC | Ответ |
|---|---|
| `dashboard_overview` | `{ counts{status:count}, byCommunity[], nextPosts[], jobs[], missedSlots, spendUsdMonth, unreadNotifications, integrations[], settings{} }` |
| `analytics_overview` | `{ points[{date, community_id, views, likes, comments, shares, source}], best[{post_id,title,community_id,score,views}], publishedCount, insufficientData, thresholds{postsForConclusions:12}, note }` |
| `get_settings` | `{mode, automationPaused, realPublishEnabled, timezone, prepareHoursAhead, aiMonthlyLimitUsd, spendUsdMonth, aiProvider, aiTextModel, aiImageModel, aiBaseUrl, notificationsEnabled, updatedAt}` — **без** `demoMode` (клиент подставляет false) |
| `schedule_post` | `{ post, jobId, dryRun }` |
| `enqueue_generation` | `{ jobId, postId, status }` либо `{ skipped: true, reason: "slot_already_approved", post }` |
| `enqueue_upcoming_generations` | `{ queued, hours }` |
| `import_analytics` | `{ imported }` |
| `missed_slots(p_lookback_days)` | `[{ community_id, scheduled_at }]` |
| `save_settings(p_patch)` | проверяет `mode ∈ {test,approval}`, `prepareHoursAhead` 1–720, `aiProvider ∈ {test,openai,compatible,custom}` (иначе `test`), возвращает `get_settings()` |

Строки постов в ответах RPC — `to_jsonb(public.posts)`, то есть **snake_case**
(`app.post_json`). Клиент приводит их к camelCase сам — см. `mapPost` в `src/data/supabase.ts`.
Любые поля, которые нужно добавить в UI, добавлять и в маппинг, и в SQL.

### 7.5 Настройки в БД (`application_settings`, ключ → смысл)

`app_mode` (`test`/`approval`), `automation_paused`, `real_publish_enabled`,
`timezone`, `prepare_hours_ahead`, `ai_monthly_limit_usd`, `ai_provider`, `ai_text_model`,
`ai_image_model`, `ai_base_url`, `notifications_enabled`, **`ai_paid_calls_enabled`** (по
умолчанию `false`: платные вызовы запрещены, пока владелец не включит осознанно),
**`worker_url`** (альтернатива vault-секрету `vk_ai_worker_url`), `schema_version`.

### 7.6 Переменные окружения Edge Functions

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`
(AES-256-GCM для VK-токенов и AI-ключа), `WORKER_SECRET` (заголовок `x-worker-secret`),
`AI_API_KEY` (перекрывает ключ из БД), `AI_BASE_URL`, `AI_TEXT_MODEL`, `AI_IMAGE_MODEL`,
`VK_API_VERSION` (5.199), `APP_ORIGINS`.
Vault: `vk_ai_worker_url`, `vk_ai_worker_secret` (для Cron).

### 7.7 Storage

- один приватный бакет `media`, лимит 12 МБ, папки `communities/`, `characters/`, `posts/`,
  `generated/`, `archive/`;
- публичных ссылок нет, только signed URL (час), клиент кэширует 50 минут;
- удалять объекты может только сервер и только если изображение не используется одобренными
  или запланированными публикациями;
- **важно**: демо-иллюстрации — SVG, а `assertVkCompatibleImage` SVG не пропускает; для
  реальной публикации нужен растровый файл.

### 7.8 Очереди, идемпотентность, защита от дублей

- `generation_jobs`, `publication_jobs`, `jobs` — захват задания одним UPDATE с `FOR UPDATE
  SKIP LOCKED`, `attempts`/`max_attempts`, `run_at`, `locked_at/locked_by`, `idempotency_key`.
- Ключ слотовой генерации: `gen:<community>:<UTC YYYYMMDDHHMI>:<full_post|text|image>`.
- Публикация: `publication_jobs.idempotency_key`, `version_hash` (несовпадение → задание
  отменяется), `finish_publication_job` с backoff; повторная отправка того же поста невозможна.
- `requeue_stale_jobs(600)` возвращает в очередь задания, зависшие более 10 минут.
- `mark_post_published` отказывается работать без действующего одобрения.

---

## 8. Этап 4 — что делать дальше (главная задача)

### 8.1 Задача

> **Прогресс (ветка `arena/23498f80-vkbablo`):** переведены оболочка и вход — `src/App.tsx`
> (гейт через `auth.status()`), `src/components/layout.tsx` (пауза, выход, счётчик непрочитанных
> через `dashboard()`/`notifications()`, индикатор `backend.label` и пометка «демонстрационные данные»),
> `src/pages/LoginPage.tsx` (`createOwner`/`signIn`). Переведено 3 из 14 файлов; остальные 11 страниц
> и `src/data/*` по-прежнему используют `@/lib/api` (в `data/local.ts` и `data/supabase.ts` это ожидаемо
> для `ApiError`). Проверка в браузере не выполнена (нет Chromium); проверено: typecheck, test, build,
> sync --check, dev-сервер отдаёт модули.


Перевести страницы с прямых вызовов `@/lib/api` на `getBackend()` из `@/data`, **сохранив
текущий дизайн, разметку, компоненты и UX**. Никаких перерисовок «с нуля».

Файлы, которые сейчас используют `@/lib/api` и подлежат миграции:

```
src/App.tsx                     (авторизация/гейт маршрутов)
src/components/layout.tsx       (шапка: пользователь, статус бэкенда, пауза автоматизации)
src/pages/LoginPage.tsx         (вход + создание владельца)
src/pages/DashboardPage.tsx
src/pages/CommunitiesPage.tsx
src/pages/CommunityDetailPage.tsx
src/pages/PostsPage.tsx
src/pages/PostDetailPage.tsx
src/pages/CalendarPage.tsx
src/pages/StudioPage.tsx
src/pages/CharactersPage.tsx
src/pages/AnalyticsPage.tsx
src/pages/SettingsPage.tsx
src/pages/NotificationsPage.tsx
```

### 8.2 Как это делать

1. Прочитать страницу целиком (`sed -n '1,220p' …`), записать какие эндпоинты/поля она
   использует, и заменить вызовы на соответствующие методы `Backend`
   (таблица соответствия ниже).
2. Проверять поведение сразу в трёх режимах: `VITE_BACKEND_MODE=demo` (по умолчанию без
   ключей), `local` (локальный стенд `npm run dev`) и — когда появится проект — `supabase`.
   UI не должен падать, если метод вернул честную ошибку (в демо-режиме часть действий
   недоступна by design — показывать причину, а не «сломалось»).
3. Добавить индикатор режима: `backend.label` из `BackendInfo` (`ДЕМО-РЕЖИМ`,
   `Локальный стенд`, `Supabase`) — владелец должен всегда видеть, где он работает.
4. Не дублировать логику одобрения на клиенте: клиент только вызывает методы, все инварианты
   на сервере. Демо-режим повторяет инварианты лишь для наглядности.

Таблица соответствия «старый вызов → метод Backend»:

| Было (`api(...)`) | Стало |
|---|---|
| `GET /api/auth/status` | `backend.auth.status()` |
| `POST /api/auth/setup` | `backend.auth.createOwner(email, password, name)` |
| `POST /api/auth/login` | `backend.auth.signIn(email, password)` |
| `POST /api/auth/logout` | `backend.auth.signOut()` |
| `GET /api/dashboard` | `backend.dashboard()` |
| `GET /api/communities`, `/:id`, `PATCH` | `communities()`, `community(id)`, `updateCommunity(id, patch)` |
| `POST /api/communities/:id/vk` | `connectVk(id, token, groupId)` / `checkVk(id)` |
| `GET /api/posts`, `/:id`, `POST`, `PATCH` | `posts(filters)`, `post(id)`, `createPost`, `editPost` |
| `/posts/:id/{approve,reject,revise,regenerate,schedule,unschedule,generate}` | `approvePost`, `rejectPost`, `revisePost`, `regeneratePost`, `schedulePost`, `unschedulePost`, `generateSlot` |
| `GET /api/calendar` | `calendar(from, to)` |
| `POST /api/ai/ideas`, `/api/ai/generate-slot`, `GET /api/ai/history`, `/api/ai/providers` | `ideas(communityId, count)`, `generateSlot(input)`, `aiHistory()`, `providers()` |
| `POST /api/automation/{prepare,pause,resume,tick}`, `GET /api/jobs` | `prepareUpcoming()`, `setAutomationPaused(true/false)`, `runWorker(task)`, `jobs()` |
| `GET/PATCH /api/characters`, `POST /:id/references` | `characters()`, `updateCharacter(id, patch)`, `uploadReference(characterId, file, notes)`, `approveReference`, `setPrimaryReference`, `deleteReference` |
| `GET /api/analytics` | `analytics()` |
| `GET/PATCH /api/settings`, `POST /api/settings/test-ai` | `settings()`, `saveSettings(patch)`, `saveAiKey(key)`, `testAi()` |
| `GET /api/notifications`, `POST /read` | `notifications()`, `markNotificationsRead(id?)` |
| `GET /api/audit` | `audit()` |
| `POST /api/uploads` | `uploadMedia(file, folder, context?)` |

### 8.3 Чеклист приёмки этапа 4

- [ ] ни одна страница/компонент больше не импортирует `@/lib/api` (кроме `src/data/local.ts`);
- [ ] `npx tsc --noEmit` чисто; `npx vite build` собирается;
- [ ] в демо-режиме (без ключей) интерфейс открывается, данные помечены как демонстрационные,
      действия VK/платных AI недоступны с понятным объяснением;
- [ ] индикатор режима виден на iPhone и MacBook, светлая/тёмная темы не сломаны;
- [ ] в календаре живут ожидаемые и пропущенные слоты, статусы и цвета сообществ;
- [ ] удалён мёртвый код `postsOn()` в `CalendarPage.tsx` (условие `…includes("")`);
- [ ] удалён неиспользуемый `DemoPostStorage` в `src/data/demo.ts`, если он не нужен.

---

## 9. Что проверено (и как повторить)

| Проверка | Команда | Результат |
|---|---|---|
| Типы фронтенда и сервера | `npm run typecheck` | чисто (обе конфигурации) |
| Юнит-тесты | `npm test` (или `npx tsx --test server/tests/*.test.ts`) | 11/11 (одобрение + канонический хэш) |
| Сборка | `npx vite build` | ОК, 341.81 kB / 106.65 kB gzip |
| Синхронность ядра | `node scripts/sync-shared.mjs --check` | ОК (10 файлов) |
| Отсутствие секретов | `git diff --cached \| grep -Ei "sk-|vk1\.|eyJ"` | чисто |
| Локальный стенд вживую | `npm run dev` + curl-сценарий | владелец создан, планировщик поставил 11 заданий, посты в `review`; планирование без одобрения отклонено; после одобрения правка текста сбросила одобрение |

Сценарий смоука локального стенда (повторяемый):

```bash
npm run dev &                       # web :5173, api :8787
J=/tmp/cookies.txt
curl -s -c $J -H 'origin: http://localhost:5173' -H 'content-type: application/json' \
  -X POST http://127.0.0.1:8787/api/auth/setup \
  -d '{"email":"owner@example.com","password":"super-secret-pass","name":"Владелец"}'
curl -s -b $J -H 'origin: http://localhost:5173' -H 'content-type: application/json' \
  -X POST http://127.0.0.1:8787/api/automation/prepare -d '{}'
curl -s -b $J http://127.0.0.1:8787/api/posts
```

---

## 10. Что **НЕ** проверено (нельзя утверждать, что работает)

1. **Миграции Supabase не применялись** — нет ни локального Postgres, ни облачного проекта.
   Синтаксис/логика RPC, RLS, триггеров и Cron **не проверялись исполнением**.
2. **Edge Functions не запускались** — ни `deno check`, ни `supabase functions serve`.
   Возможны мелкие ошибки типов Deno/импортов; проверить при первом подключении проекта.
3. **Реальные вызовы VK** (отложенная публикация `publish_date`, загрузка фото, права токена,
   лимиты, статистика) не выполнялись. Лимиты VK не верифицированы.
4. **Реальные AI-провайдеры** не вызывались. Работал только детерминированный тестовый движок.
5. **Cron на выбранном тарифе** не проверялся: нужен `pg_cron`, `pg_net` и vault-секреты.
6. **Realtime-подписки** не проверялись вживую (нет проекта).
7. **GitHub Pages** пока не разворачивался; workflow публикации отсутствует. Демо-режим
   работает без сервера по замыслу, но факт деплоя не подтверждён.
8. **Мобильная вёрстка** проверялась только по коду (дизайн сохранялся), на реальных iPhone
   и MacBook не проверялась.

---

## 11. Грабли и уже исправленные ошибки (не повторять)

1. **Не возвращать** `wrangler.toml`, `server/worker.ts`, `bindWorkerEnv`, черновики
   `supabase/migrations/0001_init.sql`, `supabase/policies.sql`, `supabase/seed.sql`.
   Канонический набор миграций — только пять файлов `2026101412*`.
2. **Legacy-хэш в `server/lib.ts`** (`JSON.stringify({c,t,i,s})`) был несовместим с
   `app.content_hash`. Теперь функция делегирует в `shared/hash.ts`. Не возвращать старую
   реализацию.
3. **`.gitignore`**: строка `data` однажды скрыла весь каталог `src/data`. Сейчас там `/data`.
   Не добавлять «коротких» имён каталогов в игнор.
4. **Приватные методы класса не могут реализовывать публичные методы интерфейса.** В
   `src/data/demo.ts` и `src/data/local.ts` вспомогательные методы были переименованы в
   `buildCommunity` / `logAudit` / `apiPost`. Новые помощники не называть как методы `Backend`.
5. **Типы Hono**: `c.json({...}, status)` требует `status as ContentfulStatusCode`
   (импорт из `hono/utils/http-status`); `c.req.param()` типизируется как `string | undefined` —
   использовать `requireParam(c, "id")` из `server/lib.ts`.
6. **node:sqlite**: параметры нужно приводить — `...(params as never[])` в `server/db.ts`.
7. **Адаптер изображений** (`server/ai.ts`) возвращает `{path, model, costUsd, note?}` —
   свойства `prompt` нет, использовать локальный `imgPrompt`. Значения `vk_post_id` и
   `approved_by` из SQLite приводить к `String(...)`.
8. **SVG**: `assertVkCompatibleImage` не пропускает SVG (демо-иллюстрации — SVG). Для реальной
   публикации нужен PNG/JPEG/WebP.
9. **`functions.invoke`** кладёт ошибку в `error.context` (это `Response`), читать через
   `await error.context.json()`; сервер отвечает `{error, code}`.
10. **Любая правка `shared/*.ts`** требует `node scripts/sync-shared.mjs`, иначе CI падает.
11. **Демо-режим не должен уметь невозможное**: `connectVk`, `saveAiKey`, включение
    `approval`-режима, `realPublishEnabled = true`, импорт аналитики — бросают понятные
    русские ошибки. Не смягчать их «на всякий случай».
12. **Мок-идентификаторы**: симуляция VK всегда даёт `vk_post_id` с префиксом `test_`;
    реальная публикация считается только при `vk_post_id` без префикса. Не менять.
13. **Секреты в чат** не отправлять даже в примерах; в документации — только имена переменных.

---

## 12. Оставшиеся задачи по этапам

### Этап 4 — интерфейс (см. §8) — главное
Перевести 12 страниц + `App.tsx` + `layout.tsx` на `getBackend()`, добавить индикатор режима,
сохранить дизайн и адаптивность, почистить мёртвый код календаря.

### Этап 5 — контент-движок (доработка)
- вынести промпты в `ai_prompt_templates` и версионировать их (таблица и сиды уже есть);
- в UI студии показывать: провайдер, модель, стоимость, промпт версии, предупреждения
  (включая честные ограничения провайдера, например отсутствие identity-lock);
- лимиты расходов: показывать `spendUsdMonth` / `aiMonthlyLimitUsd` и блокировать генерацию
  при превышении (сервер уже возвращает ошибку);
- проверка запрещённых тем и антидубль должны вызываться до постановки в очередь
  (`shared/rules.ts`, `shared/similarity.ts` уже реализованы).

### Этап 6 — планировщик (доработка UI + проверка на реальной базе)
- страница календаря: день/неделя/месяц, цвета сообществ, drag-n-drop и правка времени,
  статусы, «пропущенные слоты», пауза/возобновление, пропуск дня, массовая подготовка;
- после подключения Supabase — проверить, что Cron реально вызывает воркер и что задания
  идемпотентны; проверить восстановление после «зависших» заданий.

### Этап 7 — интеграции
- проверка прав VK-токена (`vk-ai-api/communities/vk-check` уже это умеет) и **актуальных
  лимитов VK** (в т.ч. `publish_date`, количество запросов, размеры изображений);
- решить вопрос растровых изображений для публикации (сейчас демо — SVG);
- адаптеры AI: подтверждённая передача референсов и честная индикация ограничений.

### Этап 8 — тестирование
- интеграционные тесты против тестового проекта Supabase (применение миграций, RLS,
  попытка одобрить/опубликовать без прав, двойная публикация, сброс одобрения, слоты МСК);
- тест Cron на выбранном тарифе;
- тест GitHub Pages (hash-роутинг, отсутствие 404 на вложенных путях);
- мобильная проверка (iPhone) и MacBook.

### Этап 9 — развёртывание
- **создать `.github/workflows/deploy-pages.yml`**: build → upload artifact → deploy-pages,
  `VITE_BASE=/VKBablo/`, `VITE_USE_HASH_ROUTER=true`, публичные ключи из repo variables/secrets,
  pre-deploy проверки (typecheck/test/build), возможность отката (re-run предыдущего деплоя);
- **написать `CODEX_SETUP.md`** — пошагово для владельца на macOS: инструменты (Homebrew, Node,
  GitHub CLI, Supabase CLI), вход в GitHub, клонирование репозитория, создание проекта Supabase,
  `supabase link`, `supabase db push`, `supabase functions deploy`, секреты, Auth, Storage,
  Cron + vault-секреты, GitHub Pages, проверка каждого сервиса, включение реального режима,
  где включается `ai_paid_calls_enabled` и `real_publish_enabled`, и что делать при ошибках;
- проверить `.env.example` на отсутствие реальных значений (уже так) и добавить раздел про
  сканирование истории Git на секреты.

### Этап 10 — отчёт
Обязательно указать: ссылку на GitHub, ссылку на сайт (если развёрнут), что реализовано, что
проверено, что осталось, `CODEX_SETUP.md`, необходимые тарифы/лимиты Supabase и GitHub,
и **явное подтверждение**: реальная публикация в VK выключена, платные API не вызываются,
тестовые данные помечены как тестовые.

---

## 13. Команды

```bash
npm install                       # зависимости
cp .env.example .env              # локальный стенд
npm run dev                       # web :5173 + api :8787
npm run typecheck                 # tsc для фронтенда и сервера
npm test                          # юнит-тесты (approval + hash)
npx vite build                    # production-сборка
node scripts/sync-shared.mjs      # синхронизация ядра в Edge Functions
node scripts/sync-shared.mjs --check
npx tsx server/index.ts           # только API локального стенда
```

Проверка облака (когда появится проект — сейчас нет):

```bash
supabase link --project-ref <ref>
supabase db push
supabase functions deploy vk-ai-api
supabase functions deploy vk-ai-worker
supabase secrets set ENCRYPTION_KEY=… WORKER_SECRET=… APP_ORIGINS=…
psql "$DATABASE_URL" -f supabase/tests/hash.sql
```

---

## 14. Риски и техдолг (известные, осознанные)

1. **7 предупреждений `npm audit`** (2 moderate, 5 high) — только в цепочке сборки
   (Tailwind 3 / postcss / micromatch). Production-зависимости: 0. Починка требует перехода
   на Tailwind 4 (ломающее изменение) — делать отдельно, после этапа 4, чтобы не тронуть дизайн.
2. **Миграции не применялись** — первый `supabase db push` может выявить синтаксические
   проблемы; ожидать отладку на живом Postgres.
3. **Лимиты Edge Functions** (время выполнения, память) уже учтены схемой (очереди + воркер),
   но фактическое поведение при нагрузке не измерялось.
4. **Лимиты VK API** не верифицированы; отложенная публикация может требовать иных параметров
   (например, ограничений на число отложенных постов).
5. **Тестовый движок** (`shared/content-engine.ts`) — не языковая модель. Он честно помечен в
   коде и в UI; не выдавать его результаты за «работу AI».
6. **Персонажи** — заглушки. Пока владелец не загрузит и не одобрит реальные фото, публикация
   с «похожими» иллюстрациями не обещается: эта честность закладывается в UI.
7. **Реальный сбор статистики** возможен только при `app_mode = approval` и рабочем VK-токене.
   В тестовом режиме аналитика пустая — это корректно, а не баг.

---

## 15. Что должен сделать владелец перед реальным запуском (основа для CODEX_SETUP.md)

1. Создать проект Supabase, связать локальный репозиторий (`supabase link`), применить
   миграции, развернуть функции, задать секреты; создать владельца при первом входе.
2. Проверить интеграции: `integration_status`, `supabase/tests/hash.sql`, Cron (`cron.job`),
   Storage (загрузка и подписанная ссылка), Realtime, Edge Functions (`health`).
3. Загрузить реальные фото персонажей, одобрить референсы, включить `appearance_status =
   approved` — иначе персонажи остаются заглушками.
4. Подключить VK-токен сообщества с нужными правами, проверить группу, включить
   `real_publish_enabled` **только после** проверки лимитов VK и тестовой отложенной публикации.
5. Подключить AI-провайдера: ключ в настройках (шифруется) или `AI_API_KEY`, затем
   `ai_paid_calls_enabled = true` и лимит расходов.
6. Убедиться, что на GitHub Pages заданы `VITE_SUPABASE_URL` и `VITE_SUPABASE_ANON_KEY`
   (иначе сайт откроется в демо-режиме — это безопасно, но не боевой режим).

---

## 16. Быстрая навигация «вопрос → файл»

| Вопрос | Файл |
|---|---|
| Как считается хэш одобрения? | `shared/hash.ts`, `supabase/tests/hash.sql`, §7.1 |
| Почему пост снова «на проверке»? | триггер `app.posts_sync_hash` в `20261014120000_core_schema.sql`, `shared/approval.ts` |
| Какие правила сообществ? | `shared/constants.ts` (`COMMUNITY_RULE_SETS`) — менять нельзя |
| Какие проверки текста? | `shared/rules.ts` |
| Антидубль? | `shared/similarity.ts`, `_shared/context.ts` (`loadRecentTexts`) |
| Расписание и слоты МСК? | `shared/moscow.ts`, `schedules` + `communities.schedule`, cron-задача `planner` |
| Публикация и предохранители? | `_shared/publish.ts`, RPC `claim_publication_job`/`finish_publication_job` |
| Секреты? | `_shared/secrets.ts`, `_shared/env.ts`, `.env.example`, §7.6 |
| Очереди и восстановление? | `_shared/jobs.ts`, `vk-ai-worker/index.ts`, `generation_jobs`/`publication_jobs` |
| Какие RPC есть? | `20261014120200_rpc_functions.sql`, §7.4 |
| Какие маршруты у сервера? | `vk-ai-api/index.ts` (§6.2), локальный стенд — `server/app.ts` |
| Как переключить режим данных? | `src/lib/config.ts`, `src/data/index.ts`, §8 |
| Что уже проверено? | §9 |
| Чего ещё нет? | §4, §10, §12 |
| Какие грабли? | §11 |
