import { COMMUNITY_META, STYLE_RULES, DEFAULT_GENERATION } from "../shared/constants.ts";
import { COMMUNITY_IDS, DEFAULT_SLOTS } from "../shared/types.ts";
import type { AppearanceLock, CommunityId } from "../shared/types.ts";
import { get, run, setSetting, setting } from "./db.ts";
import { nid, nowIso } from "./lib.ts";

const CHARACTERS: Array<{
  id: string;
  communityId: CommunityId;
  name: string;
  role: string;
  description: string;
  personality: string;
  appearance: AppearanceLock;
}> = [
  {
    id: "milana",
    communityId: "milana",
    name: "Милана",
    role: "Главная героиня",
    description:
      "Милана живёт в деревне, но держит планку столичного гламура. Светлые длинные волосы, ухоженные руки, любимые солнцезащитные очки даже пасмурным утром. Она искренне любит своих и искренне не понимает, зачем снимать каблуки, если во дворе лужа.",
    personality:
      "Добродушная, немного театральная, хозяйственная в своём гламурном ключе. Не злая. Спорит с бытом, а не с людьми. Любит Толечку как родного, хоть и ворчит.",
    appearance: {
      age: "моложая женщина 25–30 лет",
      hair: "длинные светлые волосы, всегда уложены, часто набок или лёгкая волна",
      eyes: "светло-зелёные, выразительные",
      face: "аккуратный макияж, стрелки, нежный румянец, ухоженная кожа",
      body: "стройная, обычная фигура, без гиперсексуализации",
      style:
        "гламур в деревне: светлое пальто или атласная блузка, золотые серьги, очки, лак на ногтях, иногда каблук на деревянных мостках",
      distinctive: [
        "длинные светлые волосы",
        "стрелки и аккуратный макияж",
        "крупные золотые серьги",
        "солнцезащитные очки",
        "контраст наряда и деревенского фона",
      ],
      neverChange: [
        "цвет и длина волос без отдельного разрешения",
        "возрастная группа",
        "не делать персонажа ребёнком",
        "никакой эротики и наготы",
      ],
    },
  },
  {
    id: "tolechka",
    communityId: "milana",
    name: "Толечка",
    role: "Постоянный персонаж",
    description:
      "Толечка — сосед и вечный напарник по деревенским делам. Добрый, слегка растерянный, носит клетчатую рубашку и кепку. Умеет починить калитку и совершенно не умеет понять, зачем Милане четыре блеска для губ.",
    personality:
      "Застенчивый, работящий, с сухим юмором. Говорит коротко. Всегда готов помочь. Смотрит на гламур Миланы с тёплой непонятливостью.",
    appearance: {
      age: "мужчина 30–40 лет",
      hair: "тёмно-русые короткие волосы, чуть взъерошены",
      eyes: "карие, добрые",
      face: "лёгкая щетина, простое открытое лицо, без гротеска",
      body: "крепкий, обычного деревенского сложения, не карикатурный",
      style: "клетчатая рубашка, жилетка или куртка, кепка, резиновые сапоги или берцы",
      distinctive: ["кепка", "клетчатая рубашка", "лёгкая щетина", "добродушный взгляд"],
      neverChange: [
        "не превращать в злодея или пьяницу-карикатуру",
        "сохранять кепку и простой стиль",
        "никакой эротики",
      ],
    },
  },
  {
    id: "veronica",
    communityId: "veronica",
    name: "Вероника",
    role: "Рассказчица и героиня",
    description:
      "Вероника, 38 лет. Женщина с опытом, чувством юмора и здоровой иронией к свиданиям. Пишет от первого лица. Ищет не идеал из фильма, а настоящего человека. Город проживания не упоминается.",
    personality:
      "Честная, тёплая, наблюдательная, с самоиронией. Не жертва и не «охотница». Умеет рассмеяться над собой. Задаёт вопросы читательницам. Не меняет биографию произвольно.",
    appearance: {
      age: "женщина 38 лет",
      hair: "тёмно-каштановые волосы средней длины, естественная укладка, иногда низкий хвост или свободные локоны",
      eyes: "карие, живые, с лёгкими лучиками улыбки",
      face: "естественное лицо 38 лет, лёгкий макияж, без фильтров «15 лет», тёплая улыбка",
      body: "обычная женская фигура, одета скромно и современно, без наготы",
      style:
        "спокойный современный стиль: бежевое пальто, свитер, джинсы, простые серьги, кофе с собой, никакого клубного образа",
      distinctive: [
        "тёмно-каштановые волосы средней длины",
        "возраст 38, без омоложения",
        "естественный макияж",
        "спокойный элегантный стиль",
      ],
      neverChange: [
        "возраст 38 лет",
        "цвет и длина волос без разрешения",
        "не указывать город",
        "не менять биографию",
        "никакой эротики и наготы",
      ],
    },
  },
];

export function seedCore() {
  const ts = nowIso();
  for (const id of COMMUNITY_IDS) {
    const meta = COMMUNITY_META[id];
    const existing = get("SELECT id FROM communities WHERE id = ?", id);
    if (existing) continue;
    run(
      `INSERT INTO communities (
        id, name, short_name, tagline, description, theme, color, avatar_url,
        vk_group_id, vk_screen_name, vk_connected, vk_token_enc, schedule,
        style_rules, generation_settings, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, ?, ?, ?, 'active', ?)`,
      id,
      meta.name,
      meta.shortName,
      meta.tagline,
      meta.description,
      meta.theme,
      meta.color,
      `/avatars/${id}.svg`,
      JSON.stringify([...DEFAULT_SLOTS]),
      JSON.stringify(STYLE_RULES[id]),
      JSON.stringify(DEFAULT_GENERATION),
      ts,
    );
  }

  for (const ch of CHARACTERS) {
    const existing = get("SELECT id FROM characters WHERE id = ?", ch.id);
    if (existing) continue;
    run(
      `INSERT INTO characters (
        id, community_id, name, role, description, appearance, personality, locked, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ch.id,
      ch.communityId,
      ch.name,
      ch.role,
      ch.description,
      JSON.stringify(ch.appearance),
      ch.personality,
      ts,
      ts,
    );
  }

  if (!setting("app_mode")) setSetting("app_mode", process.env.APP_MODE || "test");
  if (!setting("automation_paused")) setSetting("automation_paused", "0");
  if (!setting("timezone")) setSetting("timezone", "Europe/Moscow");
  if (!setting("prepare_hours_ahead")) setSetting("prepare_hours_ahead", "24");
  if (!setting("ai_monthly_limit_usd")) {
    setSetting("ai_monthly_limit_usd", process.env.AI_MONTHLY_LIMIT_USD || "20");
  }
  if (!setting("ai_provider")) setSetting("ai_provider", "test");
  if (!setting("ai_paid_calls_enabled")) {
    setSetting("ai_paid_calls_enabled", (process.env.AI_PAID_CALLS_ENABLED ?? "false").toLowerCase() === "true" ? "true" : "false");
  }
  if (!setting("ai_text_model")) setSetting("ai_text_model", "test-writer-v1");
  if (!setting("ai_image_model")) setSetting("ai_image_model", "test-illustrator-v1");
  if (!setting("ai_base_url")) setSetting("ai_base_url", "");
  if (!setting("notifications_enabled")) setSetting("notifications_enabled", "1");
  if (!setting("setup_complete")) setSetting("setup_complete", "0");
}

export { nid };
