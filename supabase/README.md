# Supabase: база, безопасность, функции, расписание

Целевая серверная архитектура проекта. Текущий проверенный deployment — только тестовый `rxzpgxejhfubenllfrpb`, 15 октября 2026; runtime evidence и ограничения приведены в `../AUDIT_REPORT.md`. PR #11 и #12 уже объединены. Для fresh install исторических core/RPC используйте guarded installer из `../CODEX_SETUP.md`: обычный db push встречает forward-reference ошибки. Cloudflare не используется нигде: фронтенд публикуется на GitHub Pages,
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
  tests/security_boundaries.sql regression checks owner/editor, Storage immutability and publication image digest
```

## Миграции (порядок применения)

| Файл | Что делает |
|---|---|
| `20261014120000_core_schema.sql` | ~24 таблицы, индексы, ограничения, триггеры, функции `app.*` (в т.ч. `app.content_hash`), бакет `media` |
| `20261014120100_rls_policies.sql` | RLS: owner/editor читают только разрешённые операционные таблицы; owner-only security/config tables; прямых browser writes нет, `anon` отключён |
| `20261014120200_rpc_functions.sql` | RPC: одобрение, сброс одобрения, планирование, очереди, персонажи, настройки, аналитика |
| `20261014120300_seed.sql` | четыре сообщества, слоты 13:30/17:30/21:30 МСК, правила v1 и история, персонажи-заглушки, провайдеры, предохранители OFF |
| `20261014120400_cron.sql` | расписание Cron через `pg_cron` + `pg_net`: тик воркера, планировщик, публикация, статистика, обслуживание, повтор зависших задач |
| `20261014120500_vk_publication_safety.sql` | DB fence до `wall.post`, unknown-result quarantine, remote cancellation lifecycle |
| `20261014120600_ai_generation_safety.sql` | AI prompts, reference capability, cost metadata; paid calls off |
| `20261014120700_generation_mode_safety.sql` | строгие generation scopes и test-mode safeguards |
| `20261014120800_owner_bootstrap_safety.sql` | one-time server-only owner bootstrap state/role promotion |
| `20261015100000_ai_budget_reservations.sql` | UTC-month budget row lock, atomic reserve/settle/release, ledger idempotency |
| `20261015101000_schedule_sync_safety.sql` | schedule slot edits preserve independent community pause; pause transitions still sync |
| `20261015102000_media_approval_integrity.sql` | byte-level SHA-256 approvals, immutable Storage objects, no authenticated overwrite; stale approvals re-enter `review` |
| `20261015103000_owner_editor_boundaries.sql` | strict owner/editor RPC, RLS, profile-role and Edge route boundaries |

Применение (после `supabase link --project-ref <ref>`):

```bash
supabase db push            # схема + RLS + RPC + сиды (только если миграции ещё не применялись)
supabase functions deploy vk-ai-api
supabase functions deploy vk-ai-worker
```

## Ключевые инварианты (проверяются базой, а не интерфейсом)

- Публикация без явного одобрения невозможна: `posts.approved_hash` обязан совпадать с `content_hash`, `approved_image_sha256` должен совпасть с digest image в job, а статусы `scheduled` / `published` без одобрения запрещены ограничениями таблицы.
- Любое изменение текста, image path, времени или сообщества сбрасывает одобрение (триггер `app.posts_sync_hash`). Отдельный `approved_image_sha256` и digest в publication job связывают approval с точными байтами приватного объекта; перед VK upload повторно сверяется SHA-256 downloaded bytes.
- Upload создаёт новый UUID path с `upsert=false`; authenticated Storage UPDATE policy (`media_owner_update`) удалена. Metadata `(bucket,path,sha256)` уникальны/immutable. Владелец не может заменить одобренные байты на том же пути.
- Для публикаций принимаются только PNG/JPEG с совпадающими signature, MIME и extension. SVG/GIF/WEBP не являются wall photo форматом; конвертации нет. После `20261015102000` прежние approved/scheduled записи переводятся в `review`: повторно загрузите PNG/JPEG и одобрите заново.
- При сбросе одобрения публикация принудительно переводится в `test_mode = true` — «случайно» уйти в VK она не может.
- `app.is_owner()` проверяет только owner; `app.is_editor()` допускает owner/editor. Editor получает только разрешённые операционные данные/действия. Интеграции, настройки и ключи, security/audit settings, профили других пользователей и owner-only controls недоступны editor; неизвестные API routes закрыты по умолчанию. Роль профиля может назначить только доверенный service-role bootstrap/admin путь, не browser profile update.
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

Выполнять только на disposable Supabase/PostgreSQL. Grammar parser не выполняет SQL; без явного разрешения не применять миграции к production.

1. Убедиться, что применены миграции `20261015102000` и `20261015103000`; до применения проверить duplicate `(bucket,path)` в `media_assets` и ожидаемый перевод старых `approved`/`scheduled` posts в `review`.
2. Проверить `select * from public.integration_status;` как owner; editor не должен читать integration status.
3. Выполнить все rollbackable SQL fixtures: `hash.sql`, `ai_budget.sql`, `schedule_sync.sql`, `security_boundaries.sql`. Последний проверяет owner/editor boundary, immutable media path/digest и отказ от публикации при mismatched digest.
4. Для конкурентного теста двух PostgreSQL connections см. `npm run test:ai-budget-concurrency` и его обязательный guard `VKBABLO_DISPOSABLE_DB_CONFIRM=I_UNDERSTAND`. Только disposable DB; HTTP к AI/VK не выполняется.
5. `select tablename, rowsecurity from pg_tables where schemaname='public' order by 1;` — проверить включённость RLS.

### Worker health — безопасная проверка без queue side effects

Owner вызывает API `settings/test-worker`; кнопки worker health в текущем UI нет. API вызывает worker с task `health` и серверным `WORKER_SECRET`. Ожидайте `{ok:true, queueTouched:false, database:"reachable"}`. Handler проверяет чтение `application_settings`; не делает claim/planner/generation и не меняет очередь. После health worker best-effort пытается записать `worker_run` в `audit_logs` (ошибка audit insert не отменяет успешный ответ), поэтому health не следует называть абсолютно read-only. Не передавать секрет в браузер вручную, командную строку или логи.

### Как подтвердить реальный Cron → HTTP → worker run

```sql
-- Cron registration; это не proof of worker execution.
select jobid, jobname, schedule, active from cron.job order by jobname;

-- SQL commands were invoked by pg_cron; HTTP is submitted asynchronously.
select jobid, status, return_message, start_time, end_time
from cron.job_run_details order by start_time desc limit 30;

-- Compare dispatch, explicit skip and completed worker handler.
select created_at, action, result, details->>'task' as task,
       details->>'requestId' as request_id, details->>'source' as source
from public.audit_logs
where action in ('cron_dispatch','worker_run','cron_skip')
order by created_at desc limit 100;

-- When pg_net response rows are retained/accessible, inspect transport result.
select a.created_at, a.details->>'task' as task, r.id,
       r.status_code, r.timed_out, r.error_msg,
       coalesce(r.content ~ '"ok"[[:space:]]*:[[:space:]]*true', false) as worker_returned_ok
from public.audit_logs a
left join net._http_response r on r.id = (a.details->>'requestId')::bigint
where a.action = 'cron_dispatch'
order by a.created_at desc limit 50;
```

`cron.job` = schedule registered; `cron.job_run_details` = cron SQL invocation only; `cron_dispatch` = pg_net accepted request submission; `net._http_response` with HTTP 2xx and `worker_returned_ok=true` = Edge handler returned `{ok:true}` when response is retained; `worker_run` with `details.source='pg_cron'` is additional positive evidence of handler completion. Worker audit insertion is best-effort, so an absent `worker_run` row alone does not prove handler failure. Correlate by `requestId`. `cron_skip` identifies missing Vault URL/secret or pg_net. To prove actual queue processing, also verify corresponding generation/publication job records; health task intentionally does not touch jobs. No actual Cron run is evidenced until there are corresponding runtime rows.

В UI проверить Auth, private Storage, upload/approval и queue; health проверить отдельным owner API вызовом. «Проверить AI» в `app_mode=test` должен использовать test adapter и не вызывать платный endpoint.
