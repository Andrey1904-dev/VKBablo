> Повторная проверка по новому ТЗ от 15.10.2026: main по-прежнему `aebf07a059a54e2cd9c05fb52efb392abde9c9c7`. Исходный `4726e7e` сохранён в истории. Дополнительно auto без config теперь отклоняется; publishable key закреплён на явно предоставленное публичное значение тестового проекта; smoke требует setup-state 200/hasOwner=true и экран входа. Добавлен unit regression test с 10 вариантами конфигурации. Ниже сохранён предыдущий отчёт; в части старых результатов и допуска bootstrap приоритет имеет это обновление.
>
> Повторные проверки: npm ci/typecheck/check:shared/production build/Pages Supabase build PASS; unit 50/50; demo browser 15/15; cloud login-screen smoke 9/9 (Chromium desktop/mobile и iPhone WebKit). Порт 5173 занят существующим сервером: browser smoke использовал временный ignored config на свободном 5175, без переиспользования чужого сервера. npm audit --omit=dev: 0, полный install: прежние 7 advisories. Runtime: настоящий owner login, 4 communities, 13 review; все 4 предохранителя подтверждены; worker health 200/ok=true/database=reachable/queueTouched=false, CORS возвращает origin Pages. Повторные upload/approval/публикации не выполнялись; ранее проверенные три PNG сохранены.
>
> Проверка bundle: ожидаемые публичные URL/key присутствуют; пароль owner, sb_secret, private key blocks и service-role JWT отсутствуют. src/shared/supabase/package/lockfile не менялись относительно main. Серверные secrets не читались и не добавлялись. Это проверка конфигурации и шаблонов, а не обещание универсального обнаружения любых секретов.
>
> Удалённые variables, push, создание PR, merge и deployment в этой работе не выполнялись: ожидается отдельное разрешение пользователя согласно разделам 5–7 ТЗ.

# Pages → тестовый Supabase: проверка и план

Проверка 15.10.2026. main `aebf07a` (PR #13 merged; #11/#12 входят в историю).

## Фактическое состояние

- Pages source = GitHub Actions, HTTPS включён. Последний deployment: https://github.com/Andrey1904-dev/VKBablo/actions/runs/38690688396 — success. Его live smoke: 9 passed, 6 skipped.
- https://andrey1904-dev.github.io/VKBablo/ открывается, revision meta соответствует main. Опубликован **demo**, не Supabase.
- Repository Actions variables и environment github-pages variables пусты. Build получает auto без URL/key и выбирает demo. Секреты не читались; workflow их не использует для этих значений.
- Дизайн и frontend runtime не изменялись. Hash router/base `/VKBablo/` уже корректны.

## Новая проверка облачного backend

Без публикации локальный production Pages artifact собран с публичными значениями тестового ref `rxzpgxejhfubenllfrpb`. Playwright подставлял только статические файлы локальной сборки под origin `https://andrey1904-dev.github.io`; Auth, PostgREST, Edge и Storage запросы выполнялись в настоящий Supabase. Это проверяет CORS origin Pages, но не подменяет финальную проверку опубликованного Supabase artifact.

Desktop Chromium, mobile Chromium, iPhone 13 WebKit:

- настоящий owner email/password login; обзор и 8 основных маршрутов открываются, JS page errors нет;
- communities: 200, 4 записи; review: 200, 13 записей в момент проверки;
- settings: 200, app_mode=test, real_publish_enabled=false, ai_paid_calls_enabled=false, ai_provider=test;
- owner worker health: 200, ok=true, database=reachable, queueTouched=false;
- protected API без JWT: 401;
- PNG multipart upload: 200 в каждом браузере; signed download 200; public download 400 (private bucket).

Добавлены 3 отдельных тестовых PNG по новым UUID paths, без связи с постами. Существующие данные не изменялись и не удалялись. Health может записывать audit logs. Автоматический Cron продолжает тестовую работу.

Это эмуляция телефона, физический телефон не проверялся. Авторизованный опубликованный Supabase сайт пока не существует. Approval/schedule/публикации не выполнялись. Test image adapter выдаёт SVG; для approval требуется ручной PNG/JPEG (ранее документированное ограничение).

## Подготовленные изменения

Ветка `codex/pages-test-supabase`, локально, без push/merge/deploy:

1. Workflow по умолчанию требует supabase; при отсутствии конфигурации сборка останавливается до deployment вместо незаметного demo fallback. Явный demo по-прежнему возможен.
2. Новый validator проверяет разрешённый тестовый URL, наличие публичного sb_publishable key, отвергает local и серверные ключи. Значения ключей не печатает. Скрипт проверен на missing/server-key/other-project/valid/demo сценариях.
3. Live smoke допускает read-only setup-state настоящего тестового проекта и экран входа существующего owner. Старый smoke блокировал setup-state и ожидал только bootstrap, поэтому мог скрыть отсутствие реального входа.
4. Demo smoke дожидается загрузки обложек перед reload. В WebKit прежняя немедленная навигация отменяла изображения; отдельная проверка подтверждает загрузку всех четырёх SVG.

## Настройки, которые надо добавить после разрешения

Именно **Repository Actions variables**, поскольку build job не привязан к github-pages environment:

| Variable | Value |
|---|---|
| VITE_BACKEND_MODE | supabase |
| VITE_SUPABASE_URL | https://rxzpgxejhfubenllfrpb.supabase.co |
| VITE_SUPABASE_ANON_KEY | sb_publishable_wwi8T0SLJzEV8TV2JzrvUw_U2IuTf_n |

Это публичный publishable key; service_role, sb_secret, WORKER_SECRET, ENCRYPTION_KEY, VK и AI ключи запрещены в frontend. Supabase CORS для origin Pages работает; повторный bootstrap и изменение Auth/Storage не требуются. Надпись существующего UI «Supabase (production)» обозначает adapter, а не режим БД: фактически проверен app_mode=test.

## План до и после разрешения публикации

1. Проверить diff ветки и результаты; подготовить PR без merge после разрешения push/PR.
2. По разрешению добавить три variables выше. Это само по себе не меняет уже опубликованный bundle; следующий main push/workflow_dispatch использует их.
3. По разрешению объединить PR или выбрать согласованный deployment revision и запустить Pages workflow. Merge main автоматически запускает публикацию.
4. Проверить build guard, deployment, revision, реальный login, сообщества/review, API/CORS, изображения и мобильный браузер на опубликованном artifact. Не создавать нового owner.
5. При проблеме согласовать возврат demo через variable и новый deployment. Данные Supabase не очищать.

Подключение к тестовому Supabase безопасно при сохранении проверенных предохранителей. Изменения тарифов, production, реальные VK-публикации и платный AI не требуются.

## Итог проверок изменений

- typecheck: PASS; unit: 49/49 PASS; Supabase Pages production build: PASS.
- Cloud-configured smoke на локальном Pages artifact: 9 PASS, 6 skipped.
- Текущий live demo с проверкой revision main: 9 PASS, 6 skipped после исправления ожидания cover images.
- Шесть skipped — два startup fault injection сценария × 3 браузера; они намеренно отключены при PAGES_URL. Авторизованные cloud проверки выполнены отдельно, как описано выше.
- npm ci сообщает прежние 7 build dependency advisories; major dependency upgrade не выполнялся. Сборка предупреждает о chunk ~730 kB.
