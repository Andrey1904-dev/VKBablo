// ВНИМАНИЕ: файл сгенерирован из shared/ командой `npm run sync:shared`.
// Правки вносите в источник: shared/<имя>.ts
import type {
  AiPromptTemplate,
  AiProviderId,
  CommunityId,
  CommunityRuleSet,
  GenerationSettings,
  StyleRules,
} from "./types.ts";

export const BRAND = {
  name: "VK AI Manager",
  short: "VKAI",
};

/** Версия VK API зафиксирована, чтобы поведение отложенной публикации не менялось внезапно. */
export const VK_API_VERSION = "5.199";

export const COMMUNITY_META: Record<
  CommunityId,
  {
    name: string;
    shortName: string;
    tagline: string;
    description: string;
    theme: string;
    color: string;
    colorToken: "stories" | "milana" | "life" | "veronica";
  }
> = {
  stories: {
    name: "Ну и история",
    shortName: "Истории",
    tagline: "Жизненные истории с неожиданным финалом",
    description:
      "Юмористические истории, жизненные ситуации, смешные недоразумения и неожиданные концовки. Яркое начало, интрига, живая разговорная подача, неожиданный финал.",
    theme: "humor-stories",
    color: "#F59E0B",
    colorToken: "stories",
  },
  milana: {
    name: "Милана и её деревенский гламур",
    shortName: "Милана",
    tagline: "Комедия деревенского гламура",
    description:
      "Комедийные приключения Миланы и Толечки. Контраст гламура и деревенского быта, постоянные персонажи с утверждённой внешностью.",
    theme: "village-glamour",
    color: "#8B5CF6",
    colorToken: "milana",
  },
  life: {
    name: "ВСЯ СУТЬ ЖИЗНИ",
    shortName: "Суть жизни",
    tagline: "Ностальгия, наблюдения, «раньше и сейчас»",
    description:
      "Жизненные наблюдения, ностальгия, сравнения прошлого и настоящего, эмоционально узнаваемые ситуации, темы, вызывающие обсуждение.",
    theme: "life-essence",
    color: "#22C55E",
    colorToken: "life",
  },
  veronica: {
    name: "Вероника в поиске настоящего мужчины",
    shortName: "Вероника",
    tagline: "Истории женщины 38 лет о знакомствах и отношениях",
    description:
      "Истории и размышления Вероники, 38 лет: знакомства, отношения, мужчины и женщины, общение с подписчиками. Город проживания не упоминается.",
    theme: "veronica-dating",
    color: "#EC4899",
    colorToken: "veronica",
  },
};

export const DEFAULT_GENERATION: GenerationSettings = {
  textProvider: "test",
  textModel: "test-writer-v1",
  imageProvider: "test",
  imageModel: "test-illustrator-v1",
  temperature: 0.85,
  maxTokens: 900,
  imageSize: "1024x1024",
  // Current mock/OpenAI-compatible adapters do not upload references.
  useReferences: false,
  prepareHoursAhead: 24,
};

export const STYLE_RULES: Record<CommunityId, StyleRules> = {
  stories: {
    voice: "Живой рассказчик, разговорный русский, как будто делится историей в чате.",
    hook: "Сильный хук в первом предложении. Сразу сцена, деталь или обещание поворота.",
    language: "Разговорный русский, короткие абзацы, без канцелярита.",
    mustInclude: ["хук", "конкретная сцена", "неожиданный финал", "юмор"],
    mustAvoid: [
      "эротика",
      "нагота",
      "контент 18+",
      "повторяющиеся сюжеты",
      "жестокость",
      "политика",
      "оскорбления",
    ],
    ending: "Неожиданный, смешной или ироничный финал. Не объяснять шутку.",
    notes: [
      "Не повторять сюжеты и концовки из истории публикаций.",
      "Изображения с выразительными эмоциями, без 18+.",
    ],
    seriesAllowed: false,
    characterNames: [],
    forbiddenFacts: [],
  },
  milana: {
    voice: "Комедийный рассказ от третьего лица, тёплый, чуть ироничный.",
    hook: "Сразу сцена с Миланой или Толечкой, контраст гламура и деревни.",
    language: "Живой русский, лёгкая просторечная окраска в репликах, без грубости.",
    mustInclude: ["Милана", "деревенский быт или гламур", "комедийная ситуация"],
    mustAvoid: [
      "эротика",
      "нагота",
      "изменение внешности персонажей",
      "жестокость",
      "высмеивание деревни со злостью",
    ],
    ending: "Панчлайн или маленькая победа персонажа, часто с иронией.",
    notes: [
      "Внешность героев строго по утверждённым референсам.",
      "Сохранять характеры и последовательность историй.",
      "Толечка — отдельный постоянный персонаж.",
    ],
    seriesAllowed: true,
    characterNames: ["Милана", "Толечка"],
    forbiddenFacts: ["произвольная смена внешности"],
  },
  life: {
    voice: "Тёплый наблюдатель. Эмоционально, без пафоса и без нравоучений.",
    hook: "Сильный эмоциональный хук: деталь из прошлого или узнаваемая сцена.",
    language: "Понятный массовой аудитории русский. Простые слова, точные образы.",
    mustInclude: ["узнаваемая ситуация", "эмоциональный крючок"],
    mustAvoid: [
      "вымышленные факты, выданные за реальные",
      "цифры цен и дат без пометки, что это иллюстрация",
      "политика",
      "агрессия",
      "эротика",
    ],
    ending: "Тихая мысль, вопрос или узнаваемый финал, без морализаторства.",
    notes: [
      "Можно серии: «Раньше и сейчас», технологии, привычки, повседневность.",
      "Не выдавать вымышленные факты за реальные. Если пример условный — обозначить.",
    ],
    seriesAllowed: true,
    characterNames: [],
    forbiddenFacts: ["выдуманная статистика как факт", "конкретные ложные новости"],
  },
  veronica: {
    voice: "От первого лица. Вероника, 38 лет. Живой, естественный, ироничный, честный.",
    hook: "Сразу личная сцена или мысль, как будто пишет подруге.",
    language: "Естественная женская речь, без глянцевых штампов и без пошлости.",
    mustInclude: ["голос Вероники", "личный опыт или наблюдение", "вопрос аудитории"],
    mustAvoid: [
      "город проживания",
      "произвольная смена биографии",
      "эротика и 18+",
      "унижение мужчин как класса",
      "токсичные советы",
    ],
    ending: "Открытый вопрос к аудитории для обсуждения.",
    notes: [
      "Посты только от лица Вероники.",
      "Единый характер и внешность по референсам.",
      "Не упоминать город проживания без отдельного разрешения.",
      "Не менять биографию персонажа произвольно.",
    ],
    seriesAllowed: true,
    firstPerson: true,
    characterNames: ["Вероника"],
    forbiddenFacts: ["город проживания", "произвольная биография"],
  },
};

/** Долговременная память сообществ (§6 ТЗ). Версия 1 — утверждённые тематики. */
export const COMMUNITY_RULE_SETS: Record<CommunityId, CommunityRuleSet> = {
  stories: {
    communityId: "stories",
    version: 1,
    theme: "Юмор и жизненные истории с неожиданной концовкой",
    textStyle:
      "Яркое начало, интрига, живая разговорная подача, неожиданный финал, читаемость с телефона, короткие абзацы.",
    audience: "Широкая аудитория 25–55, привыкла читать с телефона, любит узнаваемый бытовой юмор.",
    forbidden: [
      "эротика и нагота",
      "сексуальные действия",
      "визуальный контент 18+",
      "жестокость",
      "политика",
      "оскорбления",
    ],
    preferredTopics: [
      "смешные жизненные ситуации",
      "бытовой юмор",
      "забавные диалоги",
      "ирония",
      "неожиданные концовки",
    ],
    unwantedTopics: ["политика", "религия", "медицина и диагнозы", "чужие трагедии"],
    successfulExamples: [],
    imageRules: "Комедийная двусмысленность допустима, эротическая визуализация — нет.",
    characterRules: "Постоянных персонажей нет. Эмоции выразительные, без 18+.",
    analyticsNotes: "Загружается владельцем отдельным документом. ИИ не выдумывает цифры.",
    sources: [],
  },
  milana: {
    communityId: "milana",
    version: 1,
    theme: "Деревенский гламур и комедия контрастов",
    textStyle:
      "Тёплая ирония, короткие сцены, реплики героев, контраст ожиданий и реальности, финал-панчлайн.",
    audience: "Женщины 30–60, любят сериальные истории с постоянными героями.",
    forbidden: ["эротика", "нагота", "изменение внешности героев", "грубость", "злая карикатура на деревню"],
    preferredTopics: [
      "гламур в сельских условиях",
      "бытовые деревенские истории",
      "Толечка и Милана",
      "контраст ожиданий и реальности",
    ],
    unwantedTopics: ["политика", "алкоголь как основа сюжета", "насмешка над людьми"],
    successfulExamples: [],
    imageRules:
      "Внешность Миланы и Толечки только по утверждённым референсам. Персонажи не меняют возраст, телосложение, лицо, причёску.",
    characterRules:
      "Милана — главная героиня. Толечка — отдельный постоянный персонаж. Эталонные изображения загружает владелец.",
    analyticsNotes: "Загружается владельцем отдельным документом.",
    sources: [],
  },
  life: {
    communityId: "life",
    version: 1,
    theme: "Жизненные наблюдения и ностальгия «раньше и сейчас»",
    textStyle:
      "Тёплое узнавание, простые слова, точные детали, эмоционально значимые сравнения прошлого и настоящего.",
    audience: "Аудитория 35–65, ценит узнавание и повод поделиться своим опытом.",
    forbidden: [
      "недостоверные утверждения как факты",
      "выдуманная статистика",
      "искусственное нагнетание",
      "политика",
      "эротика",
    ],
    preferredTopics: [
      "как раньше оплачивали покупки",
      "изменения в технологиях",
      "изменения привычных сервисов",
      "покупка автомобилей раньше и сейчас",
      "стоимость жизни",
      "разница поколений",
      "привычки, которые изменились",
    ],
    unwantedTopics: ["политика", "медицинские советы", "чужие трагедии"],
    successfulExamples: [],
    imageRules: "Ностальгические образы, никаких выдуманных инфографик, поданных как факт.",
    characterRules: "Постоянных персонажей нет.",
    analyticsNotes: "Загружается владельцем отдельным документом.",
    sources: [],
  },
  veronica: {
    communityId: "veronica",
    version: 1,
    theme: "Знакомства и отношения глазами женщины 38 лет",
    textStyle: "Живой, естественный, личный, располагающий к обсуждению. От первого лица.",
    audience: "Женщины 30–55, проходят похожий опыт, ценят честность и юмор.",
    forbidden: [
      "город проживания",
      "изменение биографии",
      "эротика и 18+",
      "унижение мужчин как класса",
      "токсичные советы",
    ],
    preferredTopics: [
      "знакомства",
      "отношения",
      "мужчины и женщины",
      "личные истории",
      "размышления",
      "общение с подписчиками",
    ],
    unwantedTopics: ["политика", "движение «бывших» без юмора", "вымещение злости на аудитории"],
    successfulExamples: [],
    imageRules: "Внешность Вероники постоянная (38 лет). Город не изображается и не называется.",
    characterRules:
      "Вероника, 38 лет — единственная героиня и рассказчица. Биография не меняется без разрешения владельца.",
    analyticsNotes: "Отдельная база правил и аналитики конкурентов будет загружена владельцем.",
    sources: [],
  },
};

export const DEFAULT_AI_PROVIDERS = [
  {
    id: "test",
    name: "test" as AiProviderId,
    kind: "both" as const,
    baseUrl: "",
    textModel: "test-writer-v1",
    imageModel: "test-illustrator-v1",
    supportsReferences: false,
    supportsIdentityLock: false,
    enabled: true,
    pricePerImageUsd: 0,
    pricePer1kTokensUsd: 0,
    notes: "Встроенный детерминированный движок. Не является реальной языковой моделью.",
  },
  {
    id: "openai",
    name: "openai" as AiProviderId,
    kind: "both" as const,
    baseUrl: "https://api.openai.com/v1",
    textModel: "gpt-4o-mini",
    imageModel: "gpt-image-1",
    supportsReferences: false,
    supportsIdentityLock: false,
    enabled: true,
    pricePerImageUsd: 0.04,
    pricePer1kTokensUsd: 0.0006,
    notes:
      "Требует AI_API_KEY в серверном окружении. Текущий адаптер не передаёт референсы изображений; сходство персонажей не гарантируется.",
  },
  {
    id: "compatible",
    name: "compatible" as AiProviderId,
    kind: "both" as const,
    baseUrl: "",
    textModel: "",
    imageModel: "",
    supportsReferences: false,
    supportsIdentityLock: false,
    enabled: true,
    pricePerImageUsd: 0,
    pricePer1kTokensUsd: 0,
    notes: "Любой OpenAI-совместимый endpoint. Задаётся AI_BASE_URL и модели.",
  },
];

export const DEFAULT_AI_PROMPTS: Omit<AiPromptTemplate, "createdAt">[] = [
  {
    id: "prompt-idea-stories",
    communityId: "stories",
    kind: "idea",
    version: 1,
    name: "Идея: юмор и неожиданный финал",
    template:
      "Предложи идею поста: {{topic}}. Хук: {{hook}}. Финал должен быть неожиданным и смешным. Без 18+.",
    active: true,
  },
  {
    id: "prompt-text-stories",
    communityId: "stories",
    kind: "text",
    version: 1,
    name: "Текст: бытовая история",
    template:
      "Создай живую бытовую историю с ясным заходом и неожиданным комическим поворотом. Тема: {{topic}}. Угол: {{angle}}. Аудитория: {{audience}}. Не выдавай выдуманное за проверенный факт или реальный личный опыт; соблюдай все запреты сообщества.",
    active: true,
  },
  {
    id: "prompt-text-milana",
    communityId: "milana",
    kind: "text",
    version: 1,
    name: "Текст: Милана и Толечка",
    template:
      "Напиши тёплую комедийную сцену, где Милана — главная героиня, а Толечка — постоянный напарник. Контраст гламурных ожиданий и деревенского быта, добрый панчлайн без унижения людей. Тема: {{topic}}. Угол: {{angle}}. Соблюдай возраст, характер и правила сообщества; не выдумывай внешность.",
    active: true,
  },
  {
    id: "prompt-text-life",
    communityId: "life",
    kind: "text",
    version: 1,
    name: "Текст: жизненное наблюдение",
    template:
      "Создай тёплое наблюдение о повседневной жизни или переменах «раньше и сейчас». Тема: {{topic}}. Угол: {{angle}}. Не придумывай статистику, цены, даты или иные факты. Если деталь условная — ясно обозначь её как пример. Без искусственного возмущения.",
    active: true,
  },
  {
    id: "prompt-text-veronica",
    communityId: "veronica",
    kind: "text",
    version: 1,
    name: "Текст: Вероника",
    template:
      "Напиши от первого лица Вероники, 38 лет: живое наблюдение об отношениях или знакомстве с самоиронией и открытым вопросом аудитории. Тема: {{topic}}. Угол: {{angle}}. Не называй и не описывай город проживания, не меняй биографию, избегай эротики, 18+ и обобщений о мужчинах.",
    active: true,
  },
  {
    id: "prompt-image-stories",
    communityId: "stories",
    kind: "image",
    version: 1,
    name: "Изображение: бытовая история",
    template:
      "Тёплая редакционная иллюстрация бытовой истории, понятная эмоциональная сцена и лёгкая комическая интрига. Тема: {{topic}}. {{image_rules}} {{reference_instruction}}",
    active: true,
  },
  {
    id: "prompt-image-milana",
    communityId: "milana",
    kind: "image",
    version: 1,
    name: "Изображение: Милана и Толечка",
    template:
      "Скромная редакционная комедия о контрасте гламура и деревенского быта; Милана — главная героиня, Толечка — отдельный постоянный персонаж. Тема: {{topic}}. {{image_rules}} {{reference_instruction}}",
    active: true,
  },
  {
    id: "prompt-image-life",
    communityId: "life",
    kind: "image",
    version: 1,
    name: "Изображение: жизненное наблюдение",
    template:
      "Тёплая ностальгическая редакционная иллюстрация о повседневности и переменах «раньше и сейчас», без инфографики и неподтверждённых цифр. Тема: {{topic}}. {{image_rules}} {{reference_instruction}}",
    active: true,
  },
  {
    id: "prompt-image-veronica",
    communityId: "veronica",
    kind: "image",
    version: 1,
    name: "Изображение: Вероника",
    template:
      "Скромный современный редакционный портрет Вероники, 38 лет, без глянцевого или клубного образа. Не изображай и не называй город. Тема: {{topic}}. {{image_rules}} {{reference_instruction}}",
    active: true,
  },
];

/** Предохранители. Меняются только владельцем через настройки/секреты сервера. */
export const APP_LIMITS = {
  maxUploadBytes: 12 * 1024 * 1024,
  allowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/gif"],
  maxPostsPerRequest: 200,
  /** Минимум публикаций, чтобы делать выводы в аналитике. */
  postsForAnalyticsConclusions: 12,
  /** Минимум секунд до времени публикации при планировании. */
  minSecondsBeforePublish: 60,
  rateLimit: {
    postsPerMinute: 30,
    approvalsPerMinute: 30,
    generationsPerMinute: 10,
    uploadsPerMinute: 20,
    loginAttemptsPer10Min: 12,
  },
} as const;

export const DEFAULT_APP_SETTINGS = {
  mode: "test" as const,
  automationPaused: false,
  realPublishEnabled: false,
  timezone: "Europe/Moscow",
  prepareHoursAhead: 24,
  aiMonthlyLimitUsd: 20,
  aiProvider: "test" as AiProviderId,
  aiTextModel: "test-writer-v1",
  aiImageModel: "test-illustrator-v1",
  aiBaseUrl: "",
  notificationsEnabled: true,
} as const;

export const DEMO = {
  label: "ДЕМО-РЕЖИМ",
  note:
    "Демонстрационные данные. Публикация в VK невозможна, платные API не вызываются, статистика помечена как демонстрационная.",
  storageKey: "vkai-demo-store-v1",
} as const;
