# VKBablo — проверенный тестовый backend и дальнейшая настройка

Актуально на 15 октября 2026. Проверена основа main `9bdb5a0` плюс локальные исправления ветки `codex/verified-supabase-backend`. PR #11 и #12 уже MERGED. Прежние указания о закреплённой Arena-ветке устарели. Фактический аудит: AUDIT_REPORT.md; текущая передача: HANDOFF.md.

## Что уже сделано

Только тестовый проект `rxzpgxejhfubenllfrpb`, URL `https://rxzpgxejhfubenllfrpb.supabase.co`. Перед изменениями подтверждено отсутствие public tables, Auth users и Storage данных. Применены 19 migrations, развёрнуты vk-ai-api/vk-ai-worker v3. Проверены реальный Auth login, RLS/роли, private media, byte hash approval, worker health, тестовый publication cycle, recovery, budget race и Cron с изменением очереди.

Предохранители оставлены: app_mode=test, real_publish_enabled=false, ai_paid_calls_enabled=false, ai_provider=test. Не подключать VK tokens/paid AI и не менять тариф. Test image adapter выдаёт SVG; для approval загрузить PNG/JPEG. Автоматического approval нет. Слоты четырёх сообществ: 13:30, 17:30, 21:30 Europe/Moscow. Суточная производительность не доказана.

## Локальный frontend

Clone находится в `work/VKBablo` папки этого чата. Выполнять команды из корня clone. Ignored `.env.local` уже настроен:

```dotenv
VITE_SUPABASE_URL=https://rxzpgxejhfubenllfrpb.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_wwi8T0SLJzEV8TV2JzrvUw_U2IuTf_n
VITE_BACKEND_MODE=supabase
VITE_USE_HASH_ROUTER=true
```

```sh
npm run dev:web
```

Тестовый owner — andrey1904dev@icloud.com. Случайный пароль сохранён локально в `.verification/owner.json` с правами 600, этот файл исключён из Git через `.git/info/exclude`. Открывать его только локально; не присылать в чат и не добавлять в Git. Bootstrap уже завершён; повторно запускать его не нужно, OWNER_SETUP_SECRET удалён из Edge Secrets. Local .env.local содержит только публичные переменные, не серверные secrets.

## Доступ Supabase и миграции

CLI уже авторизован через браузерную сессию нужного аккаунта. Если доступ потерян, выполнить интерактивно:

```sh
supabase login --agent no --output-format text
supabase projects list
supabase link --project-ref rxzpgxejhfubenllfrpb
```

Не передавать token/DB password/service-role в чат. `supabase db query --linked` использует административный доступ Management API и не требует пересылать пароль БД. Вручную вызывать `security find-generic-password` не нужно: это может вызвать запрос macOS Keychain password. CLI использует штатное сохранённое разрешение.

Перед любыми изменениями сверять `supabase/.temp/project-ref`. Не изменять другие проекты. Для текущего deployment:

```sh
supabase migration list --linked
supabase db push --dry-run
node scripts/apply-test-migrations.mjs
```

У текущего проекта pending migrations нет. Уже применённые файлы не переписывать. Исправления оформлять новыми forward migrations.

Для воспроизводимого fresh install именно этого разрешённого тестового проекта предусмотрен `node scripts/apply-test-migrations.mjs --apply`. По умолчанию скрипт только показывает план, проверяет ref/remote history и отказывается от пустой истории с существующими данными. Он исполняет каждый исходный файл с deferred function validation и атомарной записью migration history, сохраняя оригинальные bytes в statements. Это необходимо из-за historical core/RPC forward references; один ранний SET в отдельной migration не переносится через сбросы CLI session. Существующий backend не сбрасывать ради повторения установки.

После apply обязательно db lint и SQL fixtures. Список всех 19 фактически применённых migration identifiers есть в AUDIT_REPORT.md. Core/RPC в этой сессии реально исполнены Management SQL, остальные — CLI; dry-run не выдаётся за исполнение.

## Повторные проверки

```sh
npm ci
npm run typecheck
npm test
npm run check:shared
npm run build
VITE_BACKEND_MODE=demo npm run build:pages
npx playwright install chromium webkit
# Остановить свой dev server на 5173 перед production smoke.
CI=true npm run test:browser
npx --yes deno check supabase/functions/vk-ai-api/index.ts supabase/functions/vk-ai-worker/index.ts
supabase db lint --linked --level error
```

Fixtures выполняются последовательно; hash.sql удаляет свои fixtures, остальные откатывают транзакцию:

```sh
for fixture in hash ai_budget schedule_sync security_boundaries rls_sessions runtime_integrity; do
  supabase db query --linked --file "supabase/tests/$fixture.sql" || break
done
```

Четыре исходных fixtures плюс rls_sessions/runtime_integrity уже реально прошли. RLS sessions используют SET ROLE anon/authenticated и claims реальных профилей; одних admin SELECT недостаточно. Budget fixture задаёт service-role claim и временные настройки только внутри откатываемой транзакции. Оригинальный psql concurrency script изучен; при его будущем запуске нужен DATABASE_URL только локально, disposable guard, остановленный worker, проверка точного ref и cleanup. В этой проверке эквивалентный race выполнен двумя независимыми Management API SQL запросами; 1 accepted, 1 denied. Все тестовые резервы освобождены, режимы/лимит восстановлены. Не повторять такие тесты рядом с рабочим worker или paid keys.

## Edge, Secrets, Auth и Storage

В Edge Secrets настроены ENCRYPTION_KEY, WORKER_SECRET, APP_ORIGINS. Платформенные SUPABASE_URL/ANON/SERVICE_ROLE используются только сервером. OWNER_SETUP_SECRET удалён после bootstrap. VK/AI ключи не подключены. Локальные временные копии серверных secrets после проверок удалены.

При необходимости повторного deployment только этого проекта:

```sh
supabase functions deploy vk-ai-api --project-ref rxzpgxejhfubenllfrpb
supabase functions deploy vk-ai-worker --project-ref rxzpgxejhfubenllfrpb
supabase functions list --project-ref rxzpgxejhfubenllfrpb
```

verify_jwt=false в config не заменяет внутреннюю авторизацию: API проверяет настоящий JWT и профиль/роль, worker — server secret. Проверять health через owner API route `settings/test-worker` (кнопки worker health в текущем UI нет): API делает явный POST с task=health. Ожидается ok=true, result.queueTouched=false, result.database=reachable. Health не обрабатывает очередь, но пытается писать audit event.

Auth global signup выключен; email provider включён для login. Remote config реально применён, login и signup denial проверены. Redirect URLs добавлены для Pages и localhost. Bucket media приватный, 12 MiB, только signed/authenticated download; Storage UPDATE/upsert для owner/editor запрещён. Upload использует новый UUID path и upsert=false. Approval digest соответствует bytes, изменение post content сбрасывает approval. Старые approvals без digest не считаются пригодными.

## Vault и Cron

Vault vk_ai_worker_url/vk_ai_worker_secret настроены. Шесть штатных jobs активны: tick */5, publication */2, planner на 15-й минуте часа, stats 25 */3, maintenance 00:35 UTC, stale recovery */20. Europe/Moscow применяется при расчёте community slots, не к UTC cron expression.

Проверено фактическое исполнение штатного tick 05:55 UTC: cron succeeded, pg_net request 6 HTTP 200, worker claimed=2/done=2, jobs действительно done. Повторный test tick request 8 в 05:56 тоже обработал два задания; временная minute job после проверки удалена. Регистрация cron.job сама по себе не является доказательством обработки.

Для проверки без вывода secrets:

```sql
select jobname,schedule,active from cron.job order by jobname;
select created_at,action,result,details->>'task' task,details->>'requestId' request_id
from audit_logs where action in ('cron_dispatch','worker_run','cron_skip')
order by created_at desc limit 30;
select a.created_at,a.details->>'task' task,r.id,r.status_code,
       r.content::jsonb#>'{result,generation}' generation
from audit_logs a join net._http_response r on r.id=(a.details->>'requestId')::bigint
where a.action='cron_dispatch' order by a.created_at desc limit 10;
```

Сопоставлять это с generation/publication job records. Unknown remote dispatch не переотправлять: восстановление переводит его в unknown для ручной сверки. В этой проверке реальные внешние запросы не выполнялись.

## GitHub Pages — подготовлено, не опубликовано

При отдельном разрешении пользователя:

1. Settings → Pages → Build and deployment → Source: GitHub Actions.
2. Repository Actions variables: VITE_SUPABASE_URL — URL выше; VITE_SUPABASE_ANON_KEY — предоставленный publishable key; VITE_BACKEND_MODE=supabase.
3. Никаких service-role, WORKER_SECRET, ENCRYPTION_KEY, VK/AI keys в VITE_*.
4. После отдельного разрешения на push/deploy выполнить workflow и проверить live artifact отдельно.

В этой сессии Pages Source, repository variables и deployment не менялись; сайт не публиковался. Workflow запускает demo browser smoke до сборки configured backend, а live verify проверяет отдельный опубликованный artifact. Существующий live smoke не заменяет выполненную здесь отдельную проверку авторизованного cloud UI.
