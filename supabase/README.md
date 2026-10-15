# Supabase: база, безопасность, функции, расписание

Production-контур проекта. Cloudflare не используется нигде: фронтенд публикуется на GitHub Pages,
вся серверная логика живёт в Supabase (PostgreSQL + RLS + Storage + Auth + Edge Functions + Cron).

Подробная пошаговая инструкция для владельца (macOS, MacBook Air M4) — [`../CODEX_SETUP.md`](../CODEX_SETUP.md).

## Состав

```
supabase/
  config.toml                  конфигурация CLI (порты, Storage 12 МБ, Auth без регистрации)
  migrations/                  схема, RLS, RPC, сиды, Cron — применяются по порядку имён
  functions/_shared/           серверное ядро Edge Functions (Deno)
  functions/_shared/core/      изоморфное ядро, синхронизируется скриптом scripts/sync-shared.mjs
  functions/vk-ai-api/         авторизованный API (все изменения: RPC + серверные инварианты)
  functions/vk-ai-worker/      воркер очередей (Cron, секрет x-worker-secret)
  tests/hash.sql               проверка совпадения хэша PostgreSQL и JS (одобрение версий)
  tests/ai_budget.sql          rollbackable SQL checks резервирования/settlement (не замена PostgreSQL concurrency test)
  tests/schedule_sync.sql      rollbackable SQL checks синхронизации слотов и статуса сообщества
```

## Миграции (порядок применения)

| Файл | Что делает |
|---|---|
| `20261014120000_core_schema.sql` | ~24 таблицы, индексы, ограничения, триггеры, функции `app.*` (в т.ч. `app.content_hash`), бакет `media` |
| `20261014120100_rls_policies.sql` | RLS: владелец/редактор — только чтение; изменения только через RPC и service role; `anon` отключён |
| `20261014120200_rpc_functions.sql` | RPC: одобрение, сброс одобрения, планирование, очереди, персонажи, настройки, аналитика |
| `20261014120300_seed.sql` | четыре сообщества, слоты 13:30/17:30/21:30 МСК, правила v1 и история, персонажи-заглушки, провайдеры, предохранители OFF |
| `20261014120400_cron.sql` | расписание Cron через `pg_cron` + `pg_net`: тик воркера, планировщик, публикация, статистика, обслуживание, повтор зависших задач |
| `20261014120500_vk_publication_safety.sql` | DB fence до `wall.post`, unknown-result quarantine, remote cancellation lifecycle |
| `20261014120600_ai_generation_safety.sql` | AI prompts, reference capability, cost metadata; paid calls off |
| `20261014120700_generation_mode_safety.sql` | строгие generation scopes и test-mode safeguards |
| `20261014120800_owner_bootstrap_safety.sql` | one-time server-only owner bootstrap state/role promotion |
| `20261015100000_ai_budget_reservations.sql` | UTC-month budget row lock, atomic reserve/settle/release, ledger idempotency |
| `20261015101000_schedule_sync_safety.sql` | schedule slot edits preserve independent community pause; pause transitions still sync |

Применение (после `supabase link --project-ref <ref>`):

```bash
supabase db push            # схема + RLS + RPC + сиды (только если миграции ещё не применялись)
supabase functions deploy vk-ai-api
supabase functions deploy vk-ai-worker
```

## Ключевые инварианты (проверяются базой, а не интерфейсом)

- Публикация без явного одобрения невозможна: `posts.approved_hash` обязан совпадать с `content_hash`,
  а статусы `scheduled` / `published` без одобрения запрещены ограничениями таблицы.
- Любое изменение текста, изображения, времени или сообщества сбрасывает одобрение (триггер `app.posts_sync_hash`).
- При сбросе одобрения публикация принудительно переводится в `test_mode = true` — «случайно» уйти в VK она не может.
- Один слот сообщества = одна публикация (уникальный частичный индекс), плюс защита от дублей по хэшу контента.
- Задания очередей идемпотентны (`idempotency_key`), захватываются одной транзакцией с блокировкой строки.
- Реальная публикация требует сразу трёх условий: `app_mode = approval`, `real_publish_enabled = true`
  и непрерванного одобрения конкретной версии; иначе отправка выполняется как симуляция с префиксом `test_`.
- Платные вызовы AI выключены, пока `ai_paid_calls_enabled = false` или `app_mode = test`; `reserve_ai_budget` дополнительно блокирует их в dry-run.
- Каждый paid request сначала резервирует консервативную оценку в `app.ai_budget_reservations` под транзакционной блокировкой строки месяца. Успех/ошибка записывается через `settle_ai_budget` и `ai_generations` в одной транзакции; повтор settlement идемпотентен.
- Если worker теряет соединение после возможного внешнего вызова, резерв остаётся активным и продолжает занимать лимит. Не освобождать его автоматически по timeout; сначала сверить стоимость с провайдером. Стоимость всё равно является оценкой, не provider invoice.

## Секреты Edge Functions

Задаются только в серверном окружении (Dashboard → Edge Functions → Secrets, CLI `supabase secrets set`
или `.env` для локального запуска). В браузер и в Git не попадают никогда.

```
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
ENCRYPTION_KEY            # AES-256-GCM для VK-токенов и AI-ключа сообщества
WORKER_SECRET             # заголовок x-worker-secret между Cron и воркером
AI_API_KEY                # опционально: перекрывает ключ, сохранённый владельцем в БД
AI_BASE_URL / AI_TEXT_MODEL / AI_IMAGE_MODEL
VK_API_VERSION            # по умолчанию 5.199
APP_ORIGINS               # разрешённые origin (GitHub Pages, localhost, предпросмотр)
```

Vault-секреты для Cron: `vk_ai_worker_url` (URL функции воркера) и `vk_ai_worker_secret`.
Если хотя бы один не задан, Cron не падает, а пропускает шаг и пишет запись в `audit_logs`.

## Хранилище

- Бакет `media` приватный (12 МБ на файл), публичных ссылок нет — только signed URL (1 час).
- Папки: `communities/`, `characters/`, `posts/`, `generated/`, `archive/`.
- Удаление объектов возможно только сервером (service role) и никогда не затрагивает изображения,
  используемые одобренными или запланированными публикациями.

## Realtime

Публикуются `posts`, `notifications`, `generation_jobs`, `publication_jobs`.
Подписка работает только с публичным anon-ключом и действующей сессией: RLS не отдаёт чужие строки.

## Проверка после подключения

1. `select * from public.integration_status;` — статусы сервисов.
2. `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/hash.sql` — hash JS/SQL совпадает; это исполнять на подключённом PostgreSQL.
3. `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/ai_budget.sql` — rollbackable reservation/settlement checks.
4. Для конкурентного теста двух PostgreSQL connections см. `npm run test:ai-budget-concurrency` и его обязательный guard `VKBABLO_DISPOSABLE_DB_CONFIRM=I_UNDERSTAND`. Запускать только на отдельной disposable БД; HTTP к AI/VK не выполняется.
5. `select tablename, rowsecurity from pg_tables where schemaname='public' order by 1;` — проверить включённость RLS на пользовательских таблицах.
6. `select jobname, schedule, active from cron.job;` — задачи Cron зарегистрированы.
7. Read-only worker health должен вернуть `{ok:true, queueTouched:false}`; он не запускает планировщик и генерацию.
8. В интерфейсе: проверить Auth, Storage, approval, отмену, очередь и сухой worker. «Проверить AI» в `app_mode=test` должен использовать test adapter и не вызывать платный endpoint.
