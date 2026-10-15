# VK AI Manager — передача проекта (handoff для следующего агента)

Документ обновляется вместе с кодом. Текущая рабочая ветка Arena —
`arena/a5adadd9-vkbablo`, основание — merge-коммит `317e660` (PR #10 уже вошёл в main).
Не переключать ветку и не переписывать пять изменений PR #10. Дата обновления: 15 октября 2026.

Читать ограничения и актуальный статус до правок. Всё, что не отмечено как проверенное, —
**не проверено** и не должно называться работающим.

## 0. Актуальная сводка для быстрого старта

1. Стек прежний: React + TypeScript + Vite; production-контур Supabase (Postgres/RLS/Auth/
   Storage/Edge Functions/Cron), отдельные local/demo режимы. Cloudflare не используется.
2. Ни Supabase-проект, ни миграции/функции, ни VK/AI ключи здесь не подключались. Реальные
   публикации, аккаунты и платные API-вызовы не выполнялись. PostgreSQL integration не выполнен.
3. Обязательное ручное одобрение остаётся инвариантом. Supabase-публикация защищена DB fence,
   хэшем одобренной версии, безопасной обработкой unknown результата и подтверждённым cancel.
   Local backend теперь принудительно test/dry-run; не использовать его для live VK.
4. `20261015100000_ai_budget_reservations.sql` добавляет транзакционный бюджет: месячная строка
   блокируется `FOR UPDATE`, paid request резервирует оценку заранее, settlement атомарно пишет
   `ai_generations`; неизвестный исход оставляет резерв занятым. SQLite tests и SQL fixture на
   минимальной PGlite-схеме прошли, но полный PostgreSQL migration/concurrency test не запускался;
   paid AI не включать до disposable PostgreSQL проверки.
5. `20261015101000_schedule_sync_safety.sql` сохраняет независимую паузу сообщества при простом
   редактировании слотов; `schedules.slots` по-прежнему синхронизируется в `communities.schedule`.
   `supabase/tests/schedule_sync.sql` и trigger прошли в изолированном PGlite fixture; полный
   PostgreSQL/Supabase migration run не выполнялся.
6. Автоматическая подготовка постов в коде существует условно: SQL planner добавляет задания
   `full_post` для будущих слотов, Edge worker генерирует draft в статус `review`. Это не
   автопубликация и не подтверждение; каждый текст/картинку владелец одобряет вручную. Работа
   требует активных Cron, Edge secrets и базы. Без них автоматизация не работает.
7. Исправлены локальные сценарии: first-owner latch под SQLite lock, отмена dry-run расписания,
   восстановление stale worker jobs, durable claim, ссылки approve/select для референсов,
   валидация upload до чтения в память. Re-upload создаёт UUID-путь и `upsert=false`.
8. GitHub Pages workflow теперь оставляет demo для browser smoke, но может собрать deployment
   в Supabase backend из публичных GitHub Actions variables `VITE_SUPABASE_URL` и
   `VITE_SUPABASE_ANON_KEY`. На текущей машине эти variables не заданы; это не подтверждает
   реальное облачное подключение.
9. Четыре сообщества и расписание остаются неизменными: 13:30 / 17:30 / 21:30 `Europe/Moscow`;
   12 заданий в сутки. Подготовка по расписанию — не гарантия ровно 12 успешных материалов,
   если воркер/бюджет/провайдер остановлен или слот уже занят/ошибочен.
10. `AUDIT_REPORT.md` содержит актуальную матрицу P0/P1/P2 и Codex next steps. Проверки этой
    копии: typecheck PASS, unit tests 41/41, обе сборки PASS, shared sync PASS (16 files), pglast
    outer-grammar parse всех 14 SQL файлов PASS, AI budget и schedule SQL fixtures на PGlite PASS,
    Deno static check обоих Edge entry points PASS. Bundle warning 730.09/730.17 kB. Полный
    PostgreSQL/Supabase, AI concurrency, RLS/Auth/Edge runtime не проверялись; psql/DB отсутствуют.
    Browser smoke заблокирован отсутствующими Chromium/WebKit.
11. Не включать live VK/paid AI и не создавать production owner без отдельного разрешения. Повторить
    `git diff --check` и перечисленные команды после следующих изменений; результаты фиксировать честно.
12. PR #10 — уже слитая база. Аудит отправляется из `arena/a5adadd9-vkbablo` в PR #11 против
    `main`; PR открыт и не объединён. Последний GitHub check `test` прошёл. Не force-push и не
    merge без отдельного разрешения.


---

## 0.1. Обновление: дизайн-система DesignVK внедрена (октябрь 2026)

Ветка редизайна: PR «Интеграция дизайна DesignVK». Что сделано:

- **Визуал перенесён из `DesignVK/vkbablo-premium-redesign-brief.zip`** (файлы
  `src/App.tsx`, `src/index.css`, `index.html` макета) в VKBablo практически 1:1:
  палитра (`--bg #09090b`, `--accent #8b5cf6` и т.д.), Inter + JetBrains Mono,
  сайдбар 252px со сворачиванием и группами навигации, топбар с хлебными крошками,
  тёмная тема по умолчанию + светлая (класс `.light`, ключ localStorage `vkai-theme`
  сохранён), тосты, модалка «Создать публикацию», адаптив 1200/900/640px.
- **Все 12 страниц + AppShell переписаны на классы дизайн-системы** (`src/index.css`),
  Tailwind остаётся только для структурных утилит; тokens цветов Tailwind удалены.
- **Палитра сообществ обновлена до макета**: stories `#F59E0B`, milana `#8B5CF6`,
  life `#22C55E`, veronica `#EC4899` (`shared/constants.ts` + `sync:shared` выполнен).
  Это только отображение, правила сообществ не тронуты.
- **Этап 4 закрыт**: страницы `Posts`, `PostDetail`, `Calendar`, `Studio`,
  `CommunityDetail` больше не зовут `@/lib/api` напрямую — всё через `getBackend()`
  (значит, работают и в demo-режиме GitHub Pages, не только с локальным API).
- **Честность сохранена**: демо-данные помечены (`demo-note` на дашборде и в аналитике),
  у персонажей — заглушки вместо выдуманных фото, аналитика без фейковых графиков,
  тумблер реальных публикаций по умолчанию выключен.
- **GitHub Pages**: workflow `pages.yml` дополнен: шаг перевода источника Pages на
  `build_type=workflow` и пост-деплой проверка, что сайт реально отдаёт собранный
  бандл (с ретраями до 2 минут — CDN распространяет деплой не мгновенно).
  **Важно:** у интеграционных токенов нет прав менять настройки Pages (403), поэтому
  репозиторий пока числится в legacy-режиме «деплой из ветки main». Артефактный деплой
  через Actions при этом работает и побеждает, но каждый пуш в main сначала на пару
  минут поднимает гонку с raw-файлами. Постоянное решение — один раз выбрать
  **Settings → Pages → Source: GitHub Actions** (владельцу, вручную).
  URL: https://andrey1904-dev.github.io/VKBablo/
- Новые ассеты: `public/covers/{id}.svg` (обложки карточек сообществ),
  `public/avatars/{id}.svg` (обновлены под новую палитру), `public/favicon.svg`.
- Проверено: `npm run typecheck` — чисто, `npm test` — 11/11, `npm run build` — ОК,
  `node scripts/sync-shared.mjs --check` — ОК.

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
- Рабочая ветка Arena: **`arena/ff5941a8-vkbablo`**. Эта сессия привязана к ней; не
  переключать/создавать другие ветки и не пушить в другие ветки.
- Коммиты исходного проекта описаны в исторических разделах; актуальный `HEAD` проверяйте
  через `git log -5 --oneline`. По завершении каждого блока делать отдельный коммит.
- До финального review: работать только на этой ветке; push только
  `git push origin arena/ff5941a8-vkbablo`; PR открыть из неё и не сливать.
- Локальный dev-сервер запускайте только по необходимости; VK/Supabase/AI всегда через моки,
  без реальных учётных записей или секретов.

---

## 3. Жёсткие ограничения (нарушение = провал задачи)

Из ТЗ и прямых указаний владельца:

1. **Не начинать заново.** Сохранять существующий дизайн, компоненты, маршруты, бизнес-логику
   и историю Git. Архитектурные изменения — только без потери работающей функциональности.
2. **Cloudflare исключён** полностью.
3. **Никаких реальных ключей и платных вызовов на этом этапе**: не требовать VK/AI/Supabase
   ключей, не вызывать платные API, не публиковать в VK. Будущая настройка описана в
   `CODEX_SETUP.md`; реальные сервисы в этом блоке не подключались.
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
| 1 | Аудит и план | ✅ исторически готово | `AUDIT.md`; исходные этапы описаны в истории handoff. |
| 2 | Архитектура Supabase | ✅ в коде | React/Vite + Supabase Edge/RPC/RLS сохранены; Cloudflare не используется. Реальный облачный контур не подключён. |
| 3 | БД + безопасность | 🟡 код есть, не применён | Добавлены миграции `20261014120500`–`20261014120800`, включая viewer-by-default profiles и закрытый one-time owner latch; ни одна не применялась. PL/pgSQL/trigger/RLS-пути требуют PostgreSQL/Supabase-проверки. |
| 4 | Интерфейс / слой данных | ✅ код есть | `src/data/*`, hash-router, существующие страницы и дизайн сохранены; безопасная отмена в `PostDetailPage`; `npm run build` и `npm run build:pages` проходят. |
| 5 | AI/content | 🟡 код + mock tests | Явные generation modes, безопасные prompt templates, точная маркировка reference support, combined cost preflight, test/mock default, paid calls off; Edge runtime и реальные провайдеры не проверялись. |
| 6 | Планировщик / публикация | 🟡 код есть, внешне не проверен | Добавлены dispatch fence, no-duplicate unknown outcome, required-image/approval guards, cancellation lifecycle и защита от генерации поверх scheduled/published. `deno check` PASS; PostgreSQL/Supabase runtime не проверен. |
| 7 | VK + AI интеграции | 🟡 mock-only | Все тесты используют injected mocks/deterministic local engine. Реальные VK/AI вызовы и тарифы не проверялись. |
| 8 | Тестирование | 🟡 локально проверено | Результаты актуальных команд — §9; provider/VK tests используют моки, `deno check` прошёл статически. Полное migration execution, реальные сервисы и Edge runtime остаются вне проверки. |
| 9 | Setup / deploy | 🟡 код и docs готовы, live setup не выполнялся | Добавлены server-only `OWNER_SETUP_SECRET`, one-time DB latch/RPCs, operator CLI и инструкции; миграции не применялись, Edge Functions не деплоились, реальный owner/Auth account не создавался. |
| 10 | Итоговый handoff | 🟡 локально обновлён | `CODEX_SETUP.md`, `.env.example`, `README.md` и этот handoff описывают безопасный bootstrap; финальные локальные проверки и актуальные итоги записаны в §9. |

Легенда: ✅ сделано и проверено указанным способом · 🟡 код есть, но проверен не полностью/не на реальном сервисе · ❌ не сделано.
---

## 5. Как система работает целиком (важно понимать до правок)

1. **Фронтенд** (GitHub Pages) общается с Supabase двумя способами:
   - **чтение** — PostgREST под RLS (пользователь видит только то, что разрешает политика);
   - **изменения** — Edge Function `vk-ai-api` (проверяет JWT, роль и вызывает RPC).
2. **Пароль/сессии** — Supabase Auth. Новый Supabase first-owner flow требует Edge-only
   `OWNER_SETUP_SECRET`, закрытого DB latch и операторского `scripts/bootstrap-owner.mjs`;
   браузерная регистрация отключена. Bootstrap не готов к production до теста миграции и Edge
   runtime. Никогда не помещать secret во frontend, `VITE_*`, URL или browser storage.
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
   `publication_jobs`; реальная отправка возможна только при `app_mode = 'approval'`,
   `real_publish_enabled = true`, активных approval/hash, действующем image, совпавших community,
   времени и VK Group snapshot, `test_mode = false`, и снятой паузе. Dry-run IDs имеют `test_*`.
6. **Публикация/отмена** — `claim_publication_job` захватывает job, затем непосредственно перед
   `wall.post` серверный `begin_publication_dispatch` под блокировками перепроверяет approval и
   ставит `dispatch_started_at`. После этого неизвестный результат/зависший job становится
   `unknown` и никогда не переотправляется автоматически; явный retry допускается только после
   определённой ошибки VK. `wall.delete` вызывается только по запросу владельца; пост считается
   отменённым лишь после подтверждённого ответа VK и успешной записи в БД.
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
| `publication-safety.ts` | сетевые-независимые проверки approval/hash/image, no-duplicate unknown outcomes, stale jobs и cancellation warnings; Node-тесты используют только моки |
| `bootstrap-safety.ts` | fixed-work comparison для setup/worker secrets; oversized values fail closed, проверяется Node unit test |

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
- `migrations/20261014120500_vk_publication_safety.sql` — additive safety migration: dispatch
  fence, strict job snapshot, ambiguous legacy/remote outcomes, community Group ID guard, explicit
  remote cancellation state machine, confirmed-only cancellation and stale-job handling. Parser
  проверяет SQL grammar; миграция не применялась и требует Postgres/Supabase validation.
- `migrations/20261014120800_owner_bootstrap_safety.sql` — profiles default to `viewer`, Auth
  trigger cannot self-promote, private/service-role-only one-time bootstrap state and serialized
  claim/record/complete RPCs; promotion + audit запись атомарны. Parser проверил только внешнюю
  SQL-грамматику; PL/pgSQL/RLS/transaction runtime не проверялись и миграция не применялась.
- `functions/_shared/*` — серверное ядро: `env.ts` (все секреты и origin-политика),
  `http.ts` (`ApiError`, CORS, `json`, `errorResponse` с маскировкой `sk-`/`vk1.`/JWT,
  `readJson`, `requireString`, `optionalString`, `assertIso`), `db.ts` (`admin`, `asUser`,
  `callRpc`, `requireUser`), `crypto.ts`, `secrets.ts` (AES-256-GCM для VK-токенов и AI-ключа),
  `storage.ts` (bucket `media`, папки, signed URL), `images.ts` (`illustrationPrompt`,
  `assertVkCompatibleImage` — **отвергает SVG**), `ai.ts` (адаптеры + `paidGuard`/`budgetGuard`),
  `vk.ts` (клиент VK), `jobs.ts` (общие помощники очередей), `context.ts` (правила + персонажи +
  недавние тексты), `references.ts` (только одобренные референсы, 30-минутные signed URL),
  `publish.ts` (approval/image preflight, dispatch fence, idempotent VK ID persistence, explicit
  unknown outcome, `wall.delete` cancellation, `collectStatistics`, `markDuePostsPublished`).
- `functions/vk-ai-api/index.ts` — 34 маршрута в `switch` + 3 вне него (`health`, `setup-state`,
  `bootstrap/owner`): `health/auth`, `integrations/status`, `posts/*` (create, edit, approve,
  reject, revise, schedule, unschedule (explicit remote delete where applicable), regenerate, generate), `planner/prepare`, `worker/run`,
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
- `pages/*` (12 страниц), `components/{ui,layout}.tsx`, `App.tsx` — UI через `getBackend()`;
  `PostDetailPage` отображает предупреждения из backend и вызывает явный unschedule route.

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
`VK_API_VERSION` (5.199), `APP_ORIGINS`, `OWNER_SETUP_SECRET` (только server-side, 32–256
символов; для first-owner CLI оператор вводит тот же secret скрыто).
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

## 8. Интерфейс и слой данных

- Существующие экраны, архитектура и DesignVK визуальный стиль сохраняются; переписывания
  приложения/редизайна в этом запросе нет.
- `src/data/*` содержит Supabase/local/demo backends, а страницы работают через `getBackend()`;
  не возвращать прямые API вызовы ради упрощения.
- В `PostDetailPage` отмена расписанного поста идёт через `posts/unschedule`. Локальная очередь
  отменяется отдельно от remote deletion. Если backend не подтвердил VK deletion, UI показывает
  ошибку/warning и не сообщает «успешно отменено».
- Ручное одобрение остаётся обязательным; изменение текста, изображения, сообщества или времени
  сбрасывает одобрение. Экраны одобрения/редактирования не обходить прямыми DB writes.
- UI на русском; расписание/цвета/четыре сообщества не менять. GitHub Pages работает в hash-router;
  `npm run build:pages` собирает demo backend без credentials.

## 9. Что проверено (и как повторить)

| Проверка | Команда / способ | Результат |
|---|---|---|
| Типы frontend + local server | `npm run typecheck` | Успешно: frontend/shared и Node server TypeScript-конфигурации. Deno Edge Functions не входят в эту команду. |
| Все Node tests | `npm test` | 41 passed, 0 failed; provider/VK transport проверяется только injected mocks, локальная генерация — test adapter. |
| Production build | `npm run build` | Успешно; JS chunk 730.09 kB minified (Vite предупреждает о чанке >500 kB). |
| GitHub Pages build | `npm run build:pages` | Успешно; demo backend + hash router; JS chunk 730.17 kB, то же предупреждение. |
| Supabase Edge static check | `npx --yes deno check supabase/functions/vk-ai-api/index.ts supabase/functions/vk-ai-worker/index.ts` | PASS для обоих entry points; это static check, не Supabase Edge runtime. |
| Owner CLI syntax | `node --check scripts/bootstrap-owner.mjs` | Успешно; network/credentials not used. |
| Shared source parity | `node scripts/sync-shared.mjs --check` | PASS: 16 generated core files совпадают; shared core не зависит от Node/Deno/process. |
| Whitespace/conflict markers | `git diff --check` | Успешно. |
| VK publication behavior | `server/tests/publication-safety.test.ts` | Mock `wall.delete`, VK-accepted/lost `wall.post` response (один запрос), unknown/repeat-job skips, approval/image guards. |
| AI provider behavior | `server/tests/ai-safety.test.ts` | Mock chat/image transports, prompt/mode/reference/budget helpers; no external request. |
| SQL outer grammar | Local `pglast.parse_sql` | Все 14 SQL файлов (11 migrations + 3 fixtures) разбираются; PL/pgSQL object dependencies и полный migration run этим не проверяются. |
| Schedule trigger regression | Isolated PGlite fixture | Миграция `20261015101000` и `supabase/tests/schedule_sync.sql` прошли на минимальной локальной схеме; full Supabase/PostgreSQL не запускался. |
| AI budget SQL regression | Isolated PGlite fixture | Миграция `20261015100000` и `supabase/tests/ai_budget.sql` прошли на минимальной локальной схеме; это не две независимые PostgreSQL-сессии. |
| Browser smoke | `npm run test:browser` | Не запущен: отсутствуют Playwright Chromium/WebKit binaries; 15 assertions не выполнялись. |

Повторить полный обязательный набор:

```bash
npm run typecheck
npm test
npm run build
npm run build:pages
node scripts/sync-shared.mjs --check
git diff --check
```

Реальные Supabase/VK/AI аккаунты, секреты, migration apply, внешние запросы и публикации в этой
проверке не использовались. Не считать SQL parser проверкой миграции на PostgreSQL.

## 10. Что **НЕ** проверено (нельзя утверждать, что работает)

1. **Полный набор миграций Supabase не применялся** — нет локального PostgreSQL/Supabase project. `pglast` разобрал внешнюю SQL-грамматику всех 14 файлов; отдельно PGlite выполнил обе новые AI-budget/schedule migration функции и rollbackable SQL tests на минимальных схемах. Остальные PL/pgSQL dependencies, RLS, grants и транзакционные пути не проверены.
2. **Edge Functions не запускались** в Deno/Supabase runtime. `deno check` для обоих entry points прошёл статически через `npx`; `supabase functions serve`, deployment и production runtime не выполнялись.
3. **Реальные VK вызовы** (отложенная публикация, upload, remote delete, права токена, лимиты, статистика) не выполнялись; production retry/cancellation lifecycle не проходил интеграционный тест.
4. **Реальные AI providers** не вызывались. Prompt/mode/reference/budget code и mock tests добавлены, но provider tariffs, Edge runtime behavior, конкурентное резервирование бюджета и live compatibility не проверялись; paid AI calls должны оставаться выключенными.
5. **Cron** и тариф Supabase не проверялись; нужны `pg_cron`, `pg_net` и настроенные Vault secrets.
6. **Realtime** и Supabase Storage/Auth не проверялись вживую; нет проекта и реальных аккаунтов.
7. **GitHub Pages deployment** не запускался в этой работе. Workflow `.github/workflows/pages.yml` существует, но внешний site/Actions deployment не проверены.
8. **Мобильная вёрстка** не проверялась на реальных iPhone/MacBook.
9. **Owner bootstrap**: код и статические проверки добавлены, но миграция `20261014120800`, Edge function и CLI не запускались на Supabase; создание аккаунта не проверено в runtime. До тестирования на разрешённом проекте production Auth не подключать.
10. `npm audit` имеет ранее выявленные 7 findings (2 moderate, 5 high); автоматический `--force` fix не запускался.

---

## 11. Грабли и уже исправленные ошибки (не повторять)

1. **Не возвращать** `wrangler.toml`, `server/worker.ts`, `bindWorkerEnv`, черновики
   `supabase/migrations/0001_init.sql`, `supabase/policies.sql`, `supabase/seed.sql`.
   Базовый набор миграций `2026101412*` дополняется безопасной миграцией
   `20261014120500_vk_publication_safety.sql`; не переписывать уже применённые миграции.
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
8. **SVG**: демо-иллюстрации SVG нельзя отправлять в VK. Реальная публикация допускает только
   проверенные PNG/JPEG; отсутствие, недоступность или иной MIME/type блокирует `wall.post`.
9. **`functions.invoke`** кладёт ошибку в `error.context` (это `Response`), читать через
   `await error.context.json()`; сервер отвечает `{error, code}`.
10. **Любая правка `shared/*.ts`** требует `node scripts/sync-shared.mjs`, иначе CI падает.
11. **Демо-режим не должен уметь невозможное**: `connectVk`, `saveAiKey`, включение
    `approval`-режима, `realPublishEnabled = true`, импорт аналитики — бросают понятные
    русские ошибки. Не смягчать их «на всякий случай».
12. **Мок-идентификаторы**: симуляция VK всегда даёт `vk_post_id` с префиксом `test_`;
    реальная публикация считается только при `vk_post_id` без префикса. Не менять.
13. **Секреты в чат** не отправлять даже в примерах; в документации — только имена переменных.
14. **Не повторять `wall.post` при неизвестном исходе.** Любой транспортный сбой/потеря ответа
    после dispatch fence — `unknown`; требуется ручная проверка VK.
15. **Не считать локальную отмену remote отменой.** Удаление в VK вызывается отдельным owner action;
    только `wall.delete` response `1` + успешная фиксация в БД даёт confirmed.
16. **Не угадывать старый VK Group ID.** Для legacy jobs без сохранённого target snapshot remote
    delete блокируется и требует ручной сверки; текущая группа не подставляется как доказанный target.

---

## 12. Оставшиеся задачи по текущему запросу

### Block 1 — безопасная публикация/отмена
Код и mock tests добавлены. Статический `deno check` прошёл; перед production необходимы:
Supabase Edge runtime check и PostgreSQL/Supabase migration validation на отдельном test project;
ручная review SQL lock order, grants, stale/unknown workflows. Не отправлять реальный
`wall.post`/`wall.delete`.

### Block 2 — AI prompt, mode, references, budgets — код/моки/static check завершены
- Общие helper-ы синхронизированы в Deno core: явные режимы и scopes, bounded user prompts,
  templates, строгие community rules, правдивый reference policy, combined cost preflight.
- Supabase и local adapters не передают reference images; metadata/warnings не обещают likeness.
- Paid calls требуют явного server-side `ai_paid_calls_enabled=true` + provider key; defaults off.
  По тестам используются только injected mocks; Deno static check прошёл, Edge runtime и тарифы не проверены.
- Partial text/image regeneration сохраняет нетронутые компоненты, меняет draft на `review` и
  сбрасывает approval. Прямая генерация не может перезаписать scheduled/published post.
- Миграция `20261014120600_ai_generation_safety.sql` добавляет cost estimate flag, поправляет
  reference capabilities и сеет prompt templates. Новая trigger migration `20261014120700...`
  защищает scheduled/published status; оба SQL-файла не применялись.

### Block 3 — owner bootstrap (локальные проверки пройдены; commit `851ae49`)
- Server-only `OWNER_SETUP_SECRET` длиной 32–256, fixed-work comparison, operator-only CLI,
  закрытый latch + service-role RPCs, Auth profile default viewer, atomic promotion/audit.
- Frontend не отправляет setup secret; first-run Supabase UI направляет к CLI.
- Не запускались реальные Auth аккаунты, миграции, functions deploy или project calls.
  Unknown outcome / незаписанный Auth ID — fail closed и требует ручной сверки до любого retry.

### Block 4 — setup/handoff/docs (обновлены)
- `CODEX_SETUP.md`, `.env.example`, `README.md`, `HANDOFF.md` описывают различия local/Supabase,
  env ownership, безопасный CLI flow, unknown VK/Auth outcomes и ограничения непроверенной миграции.
- В docs есть final Codex checklist; сохранить без реальных сервисов, секретов и аккаунтов.

### Wrap-up (архивная запись предыдущего этапа)
- На тот момент проверки прошли: `npm run typecheck`, `npm test` (30/30), обе сборки,
  shared parity (15 files), `deno check`, CLI syntax check, pglast outer SQL parse и `git diff --check`.
  Production/Pages JS chunks 725.95/726.03 kB; Vite warning >500 kB сохранён.
- Commit-и `57c6794`, `b5fe96c`, `851ae49` относятся к предыдущему этапу и сохранены в базе PR #10.
- **Статус обновлён:** `gh pr view 10` подтвердил `MERGED` 15 октября 2026. Эта архивная запись о `OPEN` больше не актуальна.
  Новые изменения — только в `arena/a5adadd9-vkbablo`; миграции и внешние интеграции всё ещё не запускались.

## 13. Команды

```bash
npm install                       # зависимости
cp .env.example .env              # локальный стенд
npm run dev                       # web :5173 + api :8787
npm run typecheck                 # tsc для фронтенда и сервера
npm test                          # unit tests, mocks only
npm run build                     # production-сборка
npm run build:pages               # GitHub Pages demo-сборка
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

1. Создать отдельный тестовый Supabase project, изучить/проверить миграции и Edge Functions,
   задать server secrets, применить миграции и deploy только после отдельного подтверждения.
   Затем оператор запускает `node scripts/bootstrap-owner.mjs` в интерактивном терминале;
   browser-based owner creation отключён. При unknown outcome не повторять вслепую.
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
