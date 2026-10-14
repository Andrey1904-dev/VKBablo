import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommunityId } from "../shared/types.ts";
import { COMMUNITY_META } from "../shared/constants.ts";
import { UPLOAD_DIR } from "./db.ts";
import { mulberry32, nid, seedFrom } from "./lib.ts";

const PALETTES: Record<CommunityId, { a: string; b: string; c: string; ink: string; paper: string }> = {
  stories: { a: "#F4C9A8", b: "#E86A33", c: "#7A2E12", ink: "#2A140C", paper: "#FFF6EE" },
  milana: { a: "#CDEBD8", b: "#2FA36B", c: "#1A5C3C", ink: "#102418", paper: "#F3FBF6" },
  life: { a: "#C9DCF6", b: "#3B7BD6", c: "#1C3F73", ink: "#101828", paper: "#F4F8FF" },
  veronica: { a: "#F6D0DC", b: "#D4537E", c: "#7A2444", ink: "#2A1018", paper: "#FFF4F7" },
};

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function wrap(text: string, n = 28): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > n) {
      if (cur) lines.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 5);
}

export function makeIllustration(opts: {
  communityId: CommunityId;
  title: string;
  topic: string;
  seed: string;
}): { path: string; prompt: string } {
  const pal = PALETTES[opts.communityId];
  const meta = COMMUNITY_META[opts.communityId];
  const rand = mulberry32(seedFrom(opts.seed));
  const blobs = Array.from({ length: 6 }, (_, i) => {
    const x = 80 + rand() * 920;
    const y = 80 + rand() * 920;
    const r = 80 + rand() * 220;
    const op = 0.12 + rand() * 0.22;
    return `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(0)}" fill="${i % 2 ? pal.b : pal.c}" opacity="${op.toFixed(2)}"/>`;
  }).join("");

  const faceX = 540;
  const faceY = 430;
  const mood = opts.communityId === "stories" ? "удивление" : opts.communityId === "milana" ? "улыбка" : opts.communityId === "life" ? "задумчивость" : "тепло";

  const lines = wrap(opts.title || opts.topic, 26);
  const text = lines
    .map(
      (ln, i) =>
        `<text x="540" y="${720 + i * 48}" text-anchor="middle" font-family="Georgia, serif" font-size="36" fill="${pal.ink}">${esc(ln)}</text>`,
    )
    .join("");

  const extra =
    opts.communityId === "milana"
      ? `<rect x="470" y="560" width="140" height="18" rx="9" fill="${pal.b}"/><text x="540" y="640" text-anchor="middle" font-size="18" fill="${pal.c}" font-family="sans-serif">Милана · Толечка</text>`
      : opts.communityId === "veronica"
        ? `<text x="540" y="640" text-anchor="middle" font-size="18" fill="${pal.c}" font-family="sans-serif">Вероника, 38</text>`
        : "";

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="1080" height="1080">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${pal.paper}"/>
      <stop offset="1" stop-color="${pal.a}"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1080" fill="url(#bg)"/>
  ${blobs}
  <rect x="72" y="72" width="936" height="936" rx="48" fill="none" stroke="${pal.b}" stroke-width="3" opacity="0.45"/>
  <text x="120" y="150" font-family="sans-serif" font-size="22" letter-spacing="3" fill="${pal.c}">${esc(meta.name.toUpperCase())}</text>
  <circle cx="${faceX}" cy="${faceY}" r="118" fill="${pal.a}" stroke="${pal.c}" stroke-width="6"/>
  <circle cx="${faceX - 40}" cy="${faceY - 20}" r="12" fill="${pal.ink}"/>
  <circle cx="${faceX + 40}" cy="${faceY - 20}" r="12" fill="${pal.ink}"/>
  <path d="M ${faceX - 36} ${faceY + 36} Q ${faceX} ${faceY + (mood === "задумчивость" ? 28 : 58)} ${faceX + 36} ${faceY + 36}" fill="none" stroke="${pal.ink}" stroke-width="8" stroke-linecap="round"/>
  ${extra}
  ${text}
  <text x="540" y="1000" text-anchor="middle" font-family="sans-serif" font-size="16" fill="${pal.c}" opacity="0.7">VK AI Manager · иллюстрация к посту</text>
</svg>`;

  const name = `${nid("img")}.svg`;
  writeFileSync(join(UPLOAD_DIR, name), svg, "utf8");
  const prompt = illustrationPrompt(opts.communityId, opts.topic, opts.title);
  return { path: `/uploads/${name}`, prompt };
}

export function illustrationPrompt(communityId: CommunityId, topic: string, title: string): string {
  const pal = COMMUNITY_META[communityId];
  const common =
    "Editorial illustration, tasteful, no photorealistic celebrities, no nudity, no erotic, no violence, no 18+ content, high-end magazine style, 1080x1080, Russian community post artwork.";
  const by: Record<CommunityId, string> = {
    stories: `Expressive characters with clear comic emotion, warm orange palette, slice-of-life mishap, unexpected punchline vibe. Topic: ${topic}. ${title}`,
    milana: `Keep character appearance locked: Milana — long blonde hair, winged eyeliner, gold earrings, glamorous but modest clothes in a Russian village setting. Tolechka — cap, plaid shirt, kind awkward man. Comedy contrast of glamour and countryside. Topic: ${topic}. ${title}`,
    life: `Nostalgic, emotional, then-and-now mood, blue palette, everyday Soviet-to-modern life details, no fake infographics presented as facts. Topic: ${topic}. ${title}`,
    veronica: `Woman 38 years old, dark chestnut medium-length hair, natural makeup, modest contemporary clothes, warm rose palette, first-person dating-life editorial portrait. Do not depict a city name. No glamour-club look. Topic: ${topic}. ${title}`,
  };
  return `${by[communityId]}\n${common}\nCommunity: ${pal.name}`;
}

export function saveUploaded(bytes: Buffer, ext: string): string {
  const safe = ext.replace(/[^\w]/g, "").slice(0, 5) || "bin";
  const name = `${nid("up")}.${safe}`;
  writeFileSync(join(UPLOAD_DIR, name), bytes);
  return `/uploads/${name}`;
}
