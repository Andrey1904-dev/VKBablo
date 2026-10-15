# VKBablo — текущая передача

Актуально: 15 октября 2026. Основа main `9bdb5a07e1665b684fc27e142f0073ba54f8ec53`; PR #11 и #12 объединены. Работа выполнена локально в `codex/verified-supabase-backend`, подготовлена для разрешённых пользователем commit/push и PR в main. Merge не разрешён. Прежняя Arena-ветка и прежний открытый статус PR #12 — история, не инструкция.

Тестовый облачный backend `rxzpgxejhfubenllfrpb` развёрнут и проверен в runtime. Применены 19 миграций; обе Edge Functions ACTIVE v3. Вход owner, ограничения ролей/RLS, private Storage, SHA-256 approval, health, explicit fixture dry-run/cancel, concurrent budget, recovery и Cron→HTTP→worker→queue подтверждены. Полные результаты и границы — в AUDIT_REPORT.md.

Сохранить четыре сообщества, дизайн, архитектуру, Europe/Moscow и слоты 13:30/17:30/21:30. Не включать реальные публикации/платный AI/VK. Настройки: app_mode=test, real_publish_enabled=false, ai_paid_calls_enabled=false, ai_provider=test. Cron включён только для тестового backend; он готовит review и не одобряет материалы.

Один test owner: andrey1904dev@icloud.com. Дополнительное разрешение пользователя позволило создать случайный пароль автоматически через предусмотренный CLI; локальное хранение — ignored `.verification/owner.json`, права 600. Не печатать этот файл в tool logs/чат и не коммитить. OWNER_SETUP_SECRET удалён. Никакой авторизации от пользователя для продолжения этого тестового проекта сейчас не требуется. Не инициировать новые обращения к Связке ключей через `security`: это вызывало системные запросы пароля; обычный Supabase CLI уже авторизован.

Локальный clone: `work/VKBablo` относительно папки чата. `.env.local` содержит публичный Supabase config; локальные серверные секреты после проверок удалены, серверные копии остаются в Edge Secrets/Vault. Для просмотра UI: npm run dev:web. Dev server надо остановить перед Playwright production smoke; тесты больше не переиспользуют чужой сервер на 5173.

Найденные ошибки исправлены добавочными миграциями и малыми Edge/config изменениями; старые миграции не переписаны. Для fresh install обычный db push исторических core/RPC недостаточен: deferred validation требуется в каждом transaction. Guarded installer `node scripts/apply-test-migrations.mjs` показывает план; `--apply` выполняет его только для указанного тестового ref. План на текущем backend пуст. Новые миграции после deployment не редактировать.

Осталось вне проверенного объёма:

- 24-часовая устойчивость/пропускная способность; не обещать 12 готовых материалов в сутки.
- Real VK и paid AI — сознательно не проверялись.
- Test image adapter выдаёт SVG; для approval требуется PNG/JPEG, cycle проверен отдельным PNG fixture.
- 7 build dependency advisories Tailwind chain; npm audit --omit=dev чист. Не делать major force upgrade без отдельной контролируемой задачи.
- Публикация Pages, GitHub Actions variables и push — только по отдельному указанию.

Документы CODEX_SETUP.md и AUDIT_REPORT.md заменяют устаревшие сведения предыдущего handoff. Fixture post_25cda6f5528215caf6 оставлен явно обозначенным, финально review с обнулённым approval; остальные review материалы не одобрялись. Временная проверочная Cron job удалена, шесть штатных оставлены.
