# VKBablo — фактическая проверка тестового Supabase

Дата: 15 октября 2026. Целевой ref: `rxzpgxejhfubenllfrpb` (VKBablo, Free).
Проверенная основа main: `9bdb5a07e1665b684fc27e142f0073ba54f8ec53`.
Исправления подготовлены для отдельного PR из `codex/verified-supabase-backend` в main. Commit/push/PR разрешены пользователем после завершения runtime проверки; merge и публикация сайта не разрешены.

## Версия и исторические инструкции

GitHub API независимо подтвердил PR #11 MERGED (merge `8a66a0e`, 03:41:09 UTC) и PR #12 MERGED (merge `9bdb5a0`, 05:30:54 UTC). Оба merge присутствуют в истории main; byte-integrity изменения `806d09e` входят в проверенный checkout. AGENTS.md в репозитории отсутствует. Прочитаны CODEX_SETUP, HANDOFF, прежний AUDIT_REPORT, .env.example, supabase/README и оба workflows. Прежние требования работать только в Arena-ветке и сведения об открытом PR #12 исторические и больше не применяются. Дизайн, React/Vite/Supabase архитектура и правила четырёх сообществ сохранены.

## Найдено и исправлено

1. Fresh install не находил unqualified pgcrypto `digest()` при CLI apply. Добавлены временные compatibility wrappers; итоговая миграция квалифицирует вызовы через `extensions` и удаляет wrappers.
2. Исторический core создаёт SQL helpers до таблиц, которые они читают. Обычный db push останавливался на отсутствующем profiles. Core и RPC фактически исполнены через Management SQL с `check_function_bodies=off`, исходные файлы сохранены, история записана в тех же транзакциях. Добавлен guarded installer `scripts/apply-test-migrations.mjs` для воспроизводимого продолжения установки. Отдельная ранняя migration с SET сама по себе недостаточна для CLI, который сбрасывает session settings между файлами.
3. Planner использовал необъявленный `r2`; job не связывался с созданным slot post, поэтому результат генерации мог не сохраниться в пост. Новая migration объявляет переменные и атомарно связывает job с post_id.
4. `missed_slots` складывал timestamp/text/time несовместимыми операторами. Исправлены приведения day к date, slot к time.
5. `posts_due_for_publication` и `posts_due_for_stats` имели SQL body, объявленный как PL/pgSQL. Исправлено новой migration; db lint после исправления не находит ошибок.
6. Service-role PostgREST UPDATE поста падал в trigger: permission denied for content_hash. Даны узкие EXECUTE grants на canonical hash helpers сервисной роли.
7. Worker обращался к owner-only get_settings без пользовательского JWT. Теперь читает серверные publish settings; ошибка их чтения останавливает обработку.
8. API health проверял queueTouched на внешнем envelope вместо вложенного result. Исправлен разбор; owner API health реально вернул 200 и queueTouched=false.
9. `[auth.email].enable_signup=false` в remote config выключал email provider вместе со входом. Email provider включён, глобальный `[auth].enable_signup=false` сохранён. Вход проверен, публичный signup реально отклонён с signup_disabled.
10. SQL fixtures теперь возвращают явный результат после rollback либо cleanup; budget fixture задаёт service-role claim. Добавлены fixtures настоящих SQL-ролей и approval/unknown lifecycle.
11. Playwright мог повторно использовать dev server на том же порту вместо production artifact. reuseExistingServer выключен. Один повторный прогон был остановлен из-за этой коллизии; исправленный прогон выполнен отдельно.

## Фактически применённые миграции

Всего 19 записей в `supabase_migrations.schema_migrations`, только в `rxzpgxejhfubenllfrpb`:

- Новые prerequisite: `20261014115900_pgcrypto_compatibility`, `20261014115930_deferred_function_validation`.
- Все исходные 13: `20261014120000_core_schema`, `20261014120100_rls_policies`, `20261014120200_rpc_functions`, `20261014120300_seed`, `20261014120400_cron`, `20261014120500_vk_publication_safety`, `20261014120600_ai_generation_safety`, `20261014120700_generation_mode_safety`, `20261014120800_owner_bootstrap_safety`, `20261015100000_ai_budget_reservations`, `20261015101000_schedule_sync_safety`, `20261015102000_media_approval_integrity`, `20261015103000_owner_editor_boundaries`.
- Новые forward fixes: `20261015104000_runtime_function_resolution`, `20261015105000_queue_query_languages`, `20261015106000_planner_post_binding`, `20261015111000_worker_hash_permissions`.

Перед первой записью подтверждены project ref и пустое состояние: public tables=0, auth.users=0, storage.objects=0, storage.buckets=0. Неожиданных исходных данных не было. Core/RPC применены Management SQL, остальные — CLI db push. Исходные миграции не переписаны. Ошибочные попытки core/RPC откатывались; наличие migration history сверено после успешного исполнения.

## Реально выполненные проверки

| Проверка | Результат и граница доказательства |
|---|---|
| npm ci | PASS, 225 пакетов; lockfile не менялся |
| Typecheck | PASS, frontend + server |
| Unit tests | PASS, 49/49; локальные adapters/mocks |
| build | PASS, обычная сборка с публичным cloud config |
| build:pages | PASS, demo artifact для smoke и Supabase artifact отдельно |
| shared sync | PASS, 18 файлов |
| Deno check | PASS, оба Edge entry points |
| db lint --linked --level error | PASS, ошибок нет; unused variable warnings при warning level остаются |
| hash.sql, ai_budget.sql, schedule_sync.sql, security_boundaries.sql | PASS в живом целевом Supabase; hash.sql удаляет свои fixtures, остальные выполняют ROLLBACK |
| rls_sessions.sql | PASS: SET ROLE anon/authenticated + JWT claims viewer/editor/owner; все изменения откатились |
| runtime_integrity.sql | PASS: reset approval/digest, отказ approval без digest, unknown dispatch quarantine; rollback-only |
| Playwright production smoke | PASS, 15/15: desktop Chromium, mobile Chromium, iPhone WebKit |
| Cloud frontend smoke | PASS: desktop Chromium + iPhone WebKit, настоящий Auth login и 8 страниц; PNG upload в desktop; обработка контролируемой 503 ошибки |
| npm audit --omit=dev | 0 advisories |
| Полный npm audit | 7 advisories (2 moderate, 5 high), build dependency chain Tailwind |

Browser production smoke проверяет изолированный demo artifact. Cloud frontend smoke отдельно обращался к реальному test Supabase; эти результаты не подменяют друг друга. Сборки предупреждают о main chunk около 730 kB.

## Supabase runtime evidence

- `vk-ai-api` и `vk-ai-worker`: ACTIVE, deployment version 3; verify_jwt=false компенсируется собственными обязательными проверками JWT/role и worker secret. API без JWT — 401; worker с неверным secret — 401.
- Создан ровно один owner `andrey1904dev@icloud.com` через штатный bootstrap CLI по дополнительному разрешению пользователя. Пароль случайный, только в ignored локальном файле `.verification/owner.json`, права 600. Одноразовый OWNER_SETUP_SECRET удалён из Edge secrets. Публичная регистрация закрыта, email/password login работает.
- Серверная матрица проверена с настоящим JWT: viewer отвергнут, editor получает health/auth, но не integrations/worker controls; owner допущен. Профиль временно менялся доверенным серверным SQL и обязательно восстановлен. Дополнительно SQL роли подтверждают RLS, запрет чтения community_secrets, запрет role promotion и owner-only RPC. Администраторские проверки не выдаются за RLS proof.
- У всех public tables включён RLS. Private bucket media: public=false, 12 MiB. Публичное чтение PNG отвергнуто, signed/authenticated download работает. Storage overwrite одобренного объекта owner JWT отвергнут с 403.
- SHA-256 скачанных PNG bytes совпал с approved_image_sha256: `6b1048f8a6d40bac0b2954c18fefa40c4ea7a96120fc2e54b7317c0e43c2bbec`. Код проверяет bytes перед VK upload и DB dispatch fence; SQL fixture отвергает mismatch. Реальные VK endpoints не вызывались.
- Explicit POST `{"task":"health"}` вернул database=reachable, queueTouched=false. Сравнение полных снимков обеих очередей до/после health не обнаружило изменений; best-effort audit запись допустима.
- Явная фикстура `post_25cda6f5528215caf6`: generation → review → PNG upload → отдельное явное тестовое approval → schedule → dry-run worker (processed=1, real=0, simulated=1) → cancellation. Job `484b39f8-df0b-4ada-bea1-d3d49a8106ab` получил `test_stories_1792129775`. После отмены пост больше не scheduled, remote id очищен; job остаётся done как история выполненной симуляции. После последующей browser PNG upload approval/digest сброшены, финальный статус review. Другие материалы не одобрялись.
- Конкурентный бюджет: два независимых Management API SQL запроса, каждый reserve=0.1 при лимите 0.15, ровно один accepted и один budget_denied. Внешних AI/VK вызовов нет. Во время теста worker был на паузе; настройки восстановлены. Прерванные CLI-adapter попытки оставляли только тестовые резервы: их UUID отдельно сверены и освобождены. Финально active reservations=0, reservedUsd=0, paidCost=0. Оригинальный psql concurrency script изучен, но не запускался из-за отсутствующего psql; выполнен его эквивалент через независимые SQL requests.
- Recovery: generation job `f6b6df70-87b6-4e97-b5f1-04f2829e6af4` реально захвачен, lease состарен на 20 минут, requeue RPC вызван, job повторно захвачен и завершён done с attempts=2. Дубликатов активных community/time slots нет. SQL fixture отдельно подтверждает unknown fence без автоматического повтора.
- Vault настроен: vk_ai_worker_url, vk_ai_worker_secret. Шесть штатных cron jobs активны. Реальный штатный tick 05:55 UTC (10:55 Asia/Yekaterinburg) имеет cron status=succeeded, pg_net request_id=6, HTTP 200, worker generation claimed=2/done=2/errors=[]. В БД соответствующие jobs имеют done и timestamps 05:55. Следующий проверочный tick request_id=8 в 05:56 также claimed=2/done=2. Есть worker_run source=pg_cron. Временное минутное расписание удалено; штатные расписания сохранены.

## Финальные предохранители и ограничения

`app_mode=test`, `real_publish_enabled=false`, `ai_paid_calls_enabled=false`, `ai_provider=test`, `automation_paused=false`, AI monthly limit=20. Один Auth user/owner. Test Cron остаётся включённым и создаёт только review, без автоматических approvals.

Тестовый image adapter выдаёт SVG; это честно обозначенная demo illustration. Для approval/VK требуется ручная загрузка PNG/JPEG. Полный цикл проверен с отдельным PNG fixture; это не доказательство PNG output тестового генератора и не основание обещать 12 готовых материалов в сутки. 24-часовой soak, реальный VK, реальный платный AI и production не проверялись и не вызывались.

Полный npm audit указывает на braces/micromatch/chokidar/fast-glob и postcss-selector-parser/postcss-nested через Tailwind 3. Это build-time обработка шаблонов/селекторов; пользовательские файлы приложения не подаются в Tailwind pipeline. Предлагаемый npm major upgrade Tailwind 4 способен изменить CSS/UI. Blind npm audit fix --force не выполнялся; отдельная контролируемая миграция dependency/toolchain остаётся отдельной работой.

GitHub Pages не опубликован, GitHub variables/Source не менялись, на этапе runtime проверки push/merge/force-push не выполнялись, тариф и платные ресурсы не менялись. Локальная frontend конфигурация находится в ignored .env.local и содержит только предоставленные публичные значения.

Guarded installer проверен в plan и --apply с пустым pending на существующем проекте; установка с нуля самим новым скриптом отдельно не повторялась, БД ради этого не сбрасывалась. Playwright после устранения коллизии сервера: 15/15 PASS. Final Supabase Pages artifact также собран успешно.

Уточнение UI: worker-health кнопки в текущей Settings нет; health проверен owner API вызовом. Browser backend-error сценарий использует существующую кнопку «Проверить AI» и контролируемый 503 ответ. Test AI probe отдельно подтверждает adapter.id=test и нулевую стоимость.
