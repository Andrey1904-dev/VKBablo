/**
 * Демонстрационная SVG-иллюстрация — изоморфный построитель строки.
 * Используется демо-режимом в браузере и локальным стендом.
 * Это явно демонстрационный контент, а не результат платной модели.
 */
import type { CommunityId } from "./types.ts";
import { COMMUNITY_META } from "./constants.ts";
import { mulberry32, seedFrom } from "./prng.ts";

const PALETTES: Record<CommunityId, { a: string; b: string; c: string; ink: string; paper: string }> = {
  stories: { a: "#F4C9A8", b: "#E86A33", c: "#7A2E12", ink: "#2A140C", paper: "#FFF6EE" },
  milana: { a: "#CDEBD8", b: "#2FA36B", c: "#1A5C3C", ink: "#102418", paper: "#F3FBF6" },
  life: { a: "#C9DCF6", b: "#3B7BD6", c: "#1C3F73", ink: "#101828", paper: "#F4F8FF" },
  veronica: { a: "#F6D0DC", b: "#D4537E", c: "#7A2444", ink: "#2A1018", paper: "#FFF4F7" },
};

function escapeXml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapLines(text: string, maxChars = 26, maxLines = 4): string[] {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((`${current} ${word}`).trim().length > maxChars) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = `${current} ${word}`.trim();
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, maxLines);
}

export function demoIllustrationSvg(input: {
  communityId: CommunityId;
  title: string;
  topic: string;
  seed: string;
  demoLabel?: string;
}): string {
  const palette = PALETTES[input.communityId];
  const meta = COMMUNITY_META[input.communityId];
  const rand = mulberry32(seedFrom(`${input.seed}${input.communityId}`));

  const blobs = Array.from({ length: 6 }, (_, index) => {
    const x = 80 + rand() * 920;
    const y = 80 + rand() * 920;
    const r = 80 + rand() * 220;
    const opacity = 0.12 + rand() * 0.22;
    return `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(0)}" fill="${
      index % 2 ? palette.b : palette.c
    }" opacity="${opacity.toFixed(2)}"/>`;
  }).join("");

  const lines = wrapLines(input.title || input.topic);
  const text = lines
    .map(
      (line, index) =>
        `<text x="540" y="${700 + index * 46}" text-anchor="middle" font-family="Georgia, serif" font-size="34" fill="${palette.ink}">${escapeXml(
          line,
        )}</text>`,
    )
    .join("");

  const extra =
    input.communityId === "milana"
      ? '<text x="540" y="640" text-anchor="middle" font-size="18" fill="#1A5C3C" font-family="sans-serif">Милана · Толечка</text>'
      : input.communityId === "veronica"
        ? '<text x="540" y="640" text-anchor="middle" font-size="18" fill="#7A2444" font-family="sans-serif">Вероника, 38</text>'
        : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="1080" height="1080">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${palette.paper}"/>
      <stop offset="1" stop-color="${palette.a}"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1080" fill="url(#bg)"/>
  ${blobs}
  <rect x="72" y="72" width="936" height="936" rx="48" fill="none" stroke="${palette.b}" stroke-width="3" opacity="0.45"/>
  <text x="120" y="150" font-family="sans-serif" font-size="22" letter-spacing="3" fill="${palette.c}">${escapeXml(
    meta.name.toUpperCase(),
  )}</text>
  <circle cx="540" cy="420" r="118" fill="${palette.a}" stroke="${palette.c}" stroke-width="6"/>
  <circle cx="500" cy="400" r="12" fill="${palette.ink}"/>
  <circle cx="580" cy="400" r="12" fill="${palette.ink}"/>
  <path d="M 504 456 Q 540 488 576 456" fill="none" stroke="${palette.ink}" stroke-width="8" stroke-linecap="round"/>
  ${extra}
  ${text}
  <text x="540" y="1000" text-anchor="middle" font-family="sans-serif" font-size="16" fill="${palette.c}" opacity="0.75">${
    input.demoLabel ?? "ДЕМО-ИЛЛЮСТРАЦИЯ · VK AI Manager"
  }</text>
</svg>`;
}

/** data:URL для предпросмотра без загрузки на сервер. */
export function demoIllustrationDataUrl(input: {
  communityId: CommunityId;
  title: string;
  topic: string;
  seed: string;
}): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(demoIllustrationSvg(input))}`;
}
