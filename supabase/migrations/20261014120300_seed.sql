-- =============================================================================
-- VK AI Manager — базовые данные.
-- Идемпотентно: можно применять повторно.
--
-- ВАЖНО (ТЗ §7): внешность персонажей НЕ выдумывается.
-- Описания ниже помечены appearance_status = 'placeholder' — это черновые заметки
-- прошлого этапа, ожидающие утверждённых референсов, которые загрузит владелец.
-- Пока основной референс не подтверждён, генерация изображений персонажа
-- работает в демонстрационном режиме и честно сообщает об ограничении.
-- =============================================================================

insert into public.communities (
  id, name, short_name, tagline, description, theme, color, avatar_url,
  schedule, style_rules, generation_settings, status, automation_enabled
) values
  ('stories', 'Ну и история', 'Истории', 'Жизненные истории с неожиданным финалом',
   'Юмористические истории, жизненные ситуации, смешные недоразумения и неожиданные концовки.',
   'humor-stories', '#E86A33', '/avatars/stories.svg',
   '["13:30","17:30","21:30"]'::jsonb,
   jsonb_build_object(
     'voice', 'Живой рассказчик, разговорный русский.',
     'hook', 'Сильный хук в первом предложении.',
     'mustInclude', jsonb_build_array('хук','конкретная сцена','неожиданный финал','юмор'),
     'mustAvoid', jsonb_build_array('эротика','нагота','контент 18+','политика','оскорбления'),
     'characterNames', '[]'::jsonb
   ),
   jsonb_build_object('textProvider','test','textModel','test-writer-v1','imageProvider','test',
                      'imageModel','test-illustrator-v1','temperature',0.85,'maxTokens',900,
                      'imageSize','1024x1024','useReferences',true,'prepareHoursAhead',24),
   'active', true),

  ('milana', 'Милана и её деревенский гламур', 'Милана', 'Комедия деревенского гламура',
   'Комедийные приключения Миланы и Толечки: контраст гламура и деревенского быта.',
   'village-glamour', '#2FA36B', '/avatars/milana.svg',
   '["13:30","17:30","21:30"]'::jsonb,
   jsonb_build_object(
     'voice', 'Комедийный рассказ от третьего лица, тёплый, чуть ироничный.',
     'hook', 'Сразу сцена с Миланой или Толечкой, контраст гламура и деревни.',
     'mustInclude', jsonb_build_array('Милана','деревенский быт или гламур','комедийная ситуация'),
     'mustAvoid', jsonb_build_array('эротика','нагота','изменение внешности персонажей','грубость'),
     'characterNames', jsonb_build_array('Милана','Толечка')
   ),
   jsonb_build_object('textProvider','test','textModel','test-writer-v1','imageProvider','test',
                      'imageModel','test-illustrator-v1','temperature',0.85,'maxTokens',900,
                      'imageSize','1024x1024','useReferences',true,'prepareHoursAhead',24),
   'active', true),

  ('life', 'ВСЯ СУТЬ ЖИЗНИ', 'Суть жизни', 'Ностальгия, наблюдения, «раньше и сейчас»',
   'Жизненные наблюдения, ностальгия, сравнения прошлого и настоящего, узнаваемые ситуации.',
   'life-essence', '#3B7BD6', '/avatars/life.svg',
   '["13:30","17:30","21:30"]'::jsonb,
   jsonb_build_object(
     'voice', 'Тёплый наблюдатель. Эмоционально, без пафоса.',
     'hook', 'Эмоциональный хук: деталь из прошлого или узнаваемая сцена.',
     'mustInclude', jsonb_build_array('узнаваемая ситуация','эмоциональный крючок'),
     'mustAvoid', jsonb_build_array('вымышленные факты как реальные','политика','агрессия','эротика'),
     'characterNames', '[]'::jsonb
   ),
   jsonb_build_object('textProvider','test','textModel','test-writer-v1','imageProvider','test',
                      'imageModel','test-illustrator-v1','temperature',0.85,'maxTokens',900,
                      'imageSize','1024x1024','useReferences',true,'prepareHoursAhead',24),
   'active', true),

  ('veronica', 'Вероника в поиске настоящего мужчины', 'Вероника',
   'Истории женщины 38 лет о знакомствах и отношениях',
   'Истории и размышления Вероники, 38 лет. Город проживания не упоминается.',
   'veronica-dating', '#D4537E', '/avatars/veronica.svg',
   '["13:30","17:30","21:30"]'::jsonb,
   jsonb_build_object(
     'voice', 'От первого лица. Вероника, 38 лет. Живой, естественный, ироничный.',
     'hook', 'Сразу личная сцена или мысль, как будто пишет подруге.',
     'mustInclude', jsonb_build_array('голос Вероники','личный опыт','вопрос аудитории'),
     'mustAvoid', jsonb_build_array('город проживания','смена биографии','эротика и 18+','унижение мужчин'),
     'characterNames', jsonb_build_array('Вероника')
   ),
   jsonb_build_object('textProvider','test','textModel','test-writer-v1','imageProvider','test',
                      'imageModel','test-illustrator-v1','temperature',0.85,'maxTokens',900,
                      'imageSize','1024x1024','useReferences',true,'prepareHoursAhead',24),
   'active', true)
on conflict (id) do update set
  name = excluded.name,
  short_name = excluded.short_name,
  tagline = excluded.tagline,
  description = excluded.description,
  theme = excluded.theme,
  color = excluded.color,
  avatar_url = excluded.avatar_url;

-- Расписание: 3 слота в день для каждого сообщества (§8).
insert into public.schedules (community_id, slots, timezone, days_of_week, paused)
select c.id, '["13:30","17:30","21:30"]'::jsonb, 'Europe/Moscow', '{1,2,3,4,5,6,7}', false
  from public.communities c
on conflict (community_id) do nothing;

-- Правила сообществ: версия 1 (память сообщества, §6).
insert into public.community_rules (
  community_id, version, theme, text_style, audience, forbidden, preferred_topics,
  unwanted_topics, image_rules, character_rules, analytics_notes, sources
) values
  ('stories', 1,
   'Юмор и жизненные истории с неожиданной концовкой',
   'Яркое начало, интрига, живая разговорная подача, неожиданный финал, читаемость с телефона.',
   'Широкая аудитория 25–55, читает с телефона, любит бытовой юмор.',
   array['эротика и нагота','сексуальные действия','визуальный контент 18+','жестокость','политика','оскорбления'],
   array['смешные жизненные ситуации','бытовой юмор','забавные диалоги','ирония','неожиданные концовки'],
   array['политика','религия','медицина и диагнозы'],
   'Комедийная двусмысленность допустима, эротическая визуализация — нет.',
   'Постоянных персонажей нет. Эмоции выразительные, без 18+.',
   'Аналитика конкурентов загружается владельцем. ИИ не выдумывает цифры.', '{}'),
  ('milana', 1,
   'Деревенский гламур и комедия контрастов',
   'Тёплая ирония, короткие сцены, реплики героев, финал-панчлайн.',
   'Женщины 30–60, любят сериальные истории с постоянными героями.',
   array['эротика','нагота','изменение внешности героев','грубость','злая карикатура на деревню'],
   array['гламур в сельских условиях','бытовые деревенские истории','Толечка и Милана','контраст ожиданий и реальности'],
   array['политика','алкоголь как основа сюжета'],
   'Внешность Миланы и Толечки только по утверждённым референсам.',
   'Милана — главная героиня. Толечка — отдельный постоянный персонаж. Референсы загружает владелец.',
   'Аналитика загружается владельцем.', '{}'),
  ('life', 1,
   'Жизненные наблюдения и ностальгия «раньше и сейчас»',
   'Тёплое узнавание, простые слова, точные детали.',
   'Аудитория 35–65, ценит узнавание и повод поделиться опытом.',
   array['недостоверные утверждения как факты','выдуманная статистика','искусственное нагнетание','политика','эротика'],
   array['как раньше оплачивали покупки','изменения в технологиях','изменения привычных сервисов','стоимость жизни','разница поколений'],
   array['политика','медицинские советы'],
   'Ностальгические образы, без выдуманных инфографик.',
   'Постоянных персонажей нет.',
   'Аналитика загружается владельцем.', '{}'),
  ('veronica', 1,
   'Знакомства и отношения глазами женщины 38 лет',
   'Живой, естественный, личный, располагающий к обсуждению. От первого лица.',
   'Женщины 30–55, ценят честность и юмор.',
   array['город проживания','изменение биографии','эротика и 18+','унижение мужчин как класса','токсичные советы'],
   array['знакомства','отношения','мужчины и женщины','личные истории','размышления','общение с подписчиками'],
   array['политика','вымещение злости на аудитории'],
   'Внешность Вероники постоянная (38 лет). Город не изображается и не называется.',
   'Вероника, 38 лет — единственная героиня и рассказчица.',
   'Отдельная база правил и аналитики конкурентов будет загружена владельцем.', '{}')
on conflict (community_id) do nothing;

insert into public.community_rule_versions (community_id, version, rules, change_note)
select cr.community_id, cr.version, to_jsonb(cr), 'начальная версия'
  from public.community_rules cr
on conflict (community_id, version) do nothing;

-- Персонажи. appearance_status = 'placeholder' — внешности НЕ утверждены.
insert into public.characters (id, community_id, name, role, description, appearance, personality, locked, appearance_status)
values
  ('milana', 'milana', 'Милана', 'Главная героиня',
   'Милана живёт в деревне, но держит планку столичного гламура. Добродушная, немного театральная, хозяйственная.',
   jsonb_build_object(
     'status', 'placeholder',
     'note', 'Черновое описание прошлого этапа. Утверждённые эталонные изображения загрузит владелец.',
     'neverChange', jsonb_build_array('возрастную группу','не делать персонажа ребёнком','никакой эротики и наготы')
   ),
   'Добродушная, немного театральная. Не злая. Спорит с бытом, а не с людьми.',
   true, 'placeholder'),
  ('tolechka', 'milana', 'Толечка', 'Постоянный персонаж',
   'Толечка — сосед и вечный напарник по деревенским делам. Добрый, слегка растерянный.',
   jsonb_build_object(
     'status', 'placeholder',
     'note', 'Утверждённая внешность будет загружена владельцем отдельным референсом.',
     'neverChange', jsonb_build_array('не превращать в злодея или карикатуру','никакой эротики')
   ),
   'Застенчивый, работящий, с сухим юмором. Говорит коротко.',
   true, 'placeholder'),
  ('veronica', 'veronica', 'Вероника', 'Рассказчица и героиня',
   'Вероника, 38 лет. Пишет от первого лица. Город проживания не упоминается.',
   jsonb_build_object(
     'status', 'placeholder',
     'note', 'Внешность будет загружена отдельно. Возраст 38 лет менять нельзя.',
     'neverChange', jsonb_build_array('возраст 38 лет','не указывать город','не менять биографию','никакой эротики и наготы')
   ),
   'Честная, тёплая, наблюдательная, с самоиронией. Не жертва и не «охотница».',
   true, 'placeholder')
on conflict (id) do nothing;

-- AI-провайдеры (метаданные; ключи хранятся отдельно и не отдаются наружу).
insert into public.ai_providers (id, name, kind, base_url, text_model, image_model,
  supports_references, supports_identity_lock, enabled, price_per_image_usd, price_per_1k_tokens_usd, notes)
values
  ('test', 'test', 'both', '', 'test-writer-v1', 'test-illustrator-v1', false, false, true, 0, 0,
   'Встроенный детерминированный движок. Не является реальной языковой моделью.'),
  ('openai', 'openai', 'both', 'https://api.openai.com/v1', 'gpt-4o-mini', 'gpt-image-1', true, false, true,
   0.04, 0.0006,
   'Требует AI_API_KEY в серверном окружении. Точное сохранение внешности персонажа не гарантируется.'),
  ('compatible', 'compatible', 'both', '', '', '', false, false, true, 0, 0,
   'Любой OpenAI-совместимый endpoint: AI_BASE_URL + модели.')
on conflict (id) do update set
  notes = excluded.notes,
  supports_references = excluded.supports_references,
  supports_identity_lock = excluded.supports_identity_lock;

-- Стартовые интеграции (честно: не подключены / демо).
insert into public.integration_status (key, label, configured, verified, status, detail)
values
  ('supabase', 'Supabase (БД, Auth, Storage)', true, false, 'configured',
   'Проект Supabase подключён: чтение через RLS, записи через RPC и Edge Functions.'),
  ('github_pages', 'GitHub Pages (интерфейс)', true, false, 'configured',
   'Статическая сборка публикуется из GitHub Actions. SPA-роутинг через hash.'),
  ('cron', 'Supabase Cron (pg_cron + pg_net)', false, false, 'off',
   'Требуется vault-секрет с URL воркера и рабочим секретом.'),
  ('ai_text', 'AI: генерация текста', false, false, 'off',
   'Ключ AI не задан. Работает тестовый движок (provider = test).'),
  ('ai_image', 'AI: генерация изображений', false, false, 'off',
   'Ключ AI не задан. Генерируются демонстрационные карточки.'),
  ('vk', 'VK API (4 сообщества)', false, false, 'off',
   'Токены не подключены. Реальные публикации запрещены (real_publish_enabled = false).'),
  ('storage', 'Supabase Storage (media, приватный)', true, false, 'configured',
   'Bucket media создан как приватный, просмотр через signed URL.'),
  ('realtime', 'Supabase Realtime', true, false, 'configured',
   'Публикации, уведомления и очереди подписаны на realtime-канал.')
on conflict (key) do update set label = excluded.label, detail = excluded.detail;

-- Настройки приложения. Предохранители по умолчанию ВЫКЛЮЧЕНЫ (§9, §19).
insert into public.application_settings (key, value) values
  ('app_mode', 'test'),
  ('automation_paused', 'false'),
  ('real_publish_enabled', 'false'),
  ('timezone', 'Europe/Moscow'),
  ('prepare_hours_ahead', '24'),
  ('ai_monthly_limit_usd', '20'),
  ('ai_provider', 'test'),
  ('ai_text_model', 'test-writer-v1'),
  ('ai_image_model', 'test-illustrator-v1'),
  ('ai_base_url', ''),
  ('notifications_enabled', 'true'),
  -- Платные вызовы AI: по умолчанию ЗАПРЕЩЕНЫ. Владелец включает их осознанно
  -- (см. CODEX_SETUP.md), и только после этого движок разрешает реальные вызовы.
  ('ai_paid_calls_enabled', 'false'),
  -- URL воркера для Cron (можно задать и через vault-секрет vk_ai_worker_url).
  ('worker_url', ''),
  ('schema_version', '2')
on conflict (key) do nothing;

-- Демонстрационные замеры НЕ создаются: аналитика должна быть либо реальной,
-- либо помеченной как демонстрационная в интерфейсе (клиентский демо-режим).
