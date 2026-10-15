-- AI prompt, reference, and cost-estimate hardening.
-- Additive migration: existing tables/settings are preserved; paid calls remain off by default.

alter table public.ai_generations
  add column if not exists cost_estimated boolean not null default false;

update public.ai_providers
   set supports_references = false,
       supports_identity_lock = false,
       notes = case id
         when 'openai' then 'Текущий адаптер использует chat/completions и images/generations без загрузки референсов. Точное сходство не гарантируется.'
         when 'compatible' then 'OpenAI-совместимый endpoint. Текущий адаптер не передаёт изображения-референсы; тарифы задаются серверной оценкой.'
         else notes
       end,
       updated_at = now()
 where id in ('openai', 'compatible');

-- Do not advertise reference transfer in default generation settings until a provider implements it.
update public.communities
   set generation_settings = jsonb_set(generation_settings, '{useReferences}', 'false'::jsonb, true),
       updated_at = now()
 where generation_settings is not null
   and generation_settings ? 'useReferences';

-- Runtime falls back to the same built-in templates if a deployment has not yet applied this seed.
insert into public.ai_prompt_templates (id, community_id, kind, version, name, template, active)
values
  ('prompt-idea-stories', 'stories', 'idea', 1, 'Идея: юмор и неожиданный финал',
   'Предложи идею поста: {{topic}}. Хук: {{hook}}. Финал должен быть неожиданным и смешным. Без 18+.', true),
  ('prompt-text-stories', 'stories', 'text', 1, 'Текст: бытовая история',
   'Создай живую бытовую историю с ясным заходом и неожиданным комическим поворотом. Тема: {{topic}}. Угол: {{angle}}. Аудитория: {{audience}}. Не выдавай выдуманное за проверенный факт или реальный личный опыт; соблюдай все запреты сообщества.', true),
  ('prompt-text-milana', 'milana', 'text', 1, 'Текст: Милана и Толечка',
   'Напиши тёплую комедийную сцену, где Милана — главная героиня, а Толечка — постоянный напарник. Контраст гламурных ожиданий и деревенского быта, добрый панчлайн без унижения людей. Тема: {{topic}}. Угол: {{angle}}. Соблюдай возраст, характер и правила сообщества; не выдумывай внешность.', true),
  ('prompt-text-life', 'life', 'text', 1, 'Текст: жизненное наблюдение',
   'Создай тёплое наблюдение о повседневной жизни или переменах «раньше и сейчас». Тема: {{topic}}. Угол: {{angle}}. Не придумывай статистику, цены, даты или иные факты. Если деталь условная — ясно обозначь её как пример. Без искусственного возмущения.', true),
  ('prompt-text-veronica', 'veronica', 'text', 1, 'Текст: Вероника',
   'Напиши от первого лица Вероники, 38 лет: живое наблюдение об отношениях или знакомстве с самоиронией и открытым вопросом аудитории. Тема: {{topic}}. Угол: {{angle}}. Не называй и не описывай город проживания, не меняй биографию, избегай эротики, 18+ и обобщений о мужчинах.', true),
  ('prompt-image-stories', 'stories', 'image', 1, 'Изображение: бытовая история',
   'Тёплая редакционная иллюстрация бытовой истории, понятная эмоциональная сцена и лёгкая комическая интрига. Тема: {{topic}}. {{image_rules}} {{reference_instruction}}', true),
  ('prompt-image-milana', 'milana', 'image', 1, 'Изображение: Милана и Толечка',
   'Скромная редакционная комедия о контрасте гламура и деревенского быта; Милана — главная героиня, Толечка — отдельный постоянный персонаж. Тема: {{topic}}. {{image_rules}} {{reference_instruction}}', true),
  ('prompt-image-life', 'life', 'image', 1, 'Изображение: жизненное наблюдение',
   'Тёплая ностальгическая редакционная иллюстрация о повседневности и переменах «раньше и сейчас», без инфографики и неподтверждённых цифр. Тема: {{topic}}. {{image_rules}} {{reference_instruction}}', true),
  ('prompt-image-veronica', 'veronica', 'image', 1, 'Изображение: Вероника',
   'Скромный современный редакционный портрет Вероники, 38 лет, без глянцевого или клубного образа. Не изображай и не называй город. Тема: {{topic}}. {{image_rules}} {{reference_instruction}}', true)
on conflict (id) do update set
  community_id = excluded.community_id,
  kind = excluded.kind,
  version = excluded.version,
  name = excluded.name,
  template = excluded.template,
  active = excluded.active;
