/**
 * Канонический хэш — фундамент привязки одобрения (ТЗ §10).
 *
 * Тест фиксирует контракт между JS-реализацией (shared/hash.ts, используется
 * браузером, Deno и Node) и PostgreSQL (app.content_hash, см. supabase/tests/hash.sql):
 * одинаковые векторы обязаны давать одинаковые значения во всех средах.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonicalUtc,
  contentHash,
  contentHashInput,
  normalizeText,
  sha256Hex,
  shortHash,
} from "../../shared/hash.ts";

/** Векторы совпадают с supabase/tests/hash.sql — менять только вместе с SQL. */
const VECTORS = [
  {
    title: "stories: CRLF и лишние пробелы нормализуются",
    input: {
      communityId: "stories",
      text: "  Первая строка\r\nВторая строка  ",
      imagePath: "posts/abc.png",
      scheduledAt: "2026-10-15T10:30:00.000Z",
    },
    expected: "81fb523623dab6ba45eaca3e50ce3bf909e94459eeb8dad7d5dc71790c287eb0",
  },
  {
    title: "milana: без изображения и с московским смещением +03:00",
    input: {
      communityId: "milana",
      text: "Милана и Толечка: тест",
      imagePath: null,
      scheduledAt: "2026-01-02T18:30:00+03:00",
    },
    expected: "51102f7386938200332c5c2c937499f6dd89b3c1606f00b3cdc3813444f90c99",
  },
  {
    title: "veronica: кавычки-ёлочки и юникод в UTF-8",
    input: {
      communityId: "veronica",
      text: "Мне 38, и я больше не разгоняюсь с первого «привет».",
      imagePath: "generated/x.jpg",
      scheduledAt: "2026-03-05T14:30:00.000Z",
    },
    expected: "8ab25324b6f62a62268c208edaedaede0b6af6d2fa447d32679657376e19161d",
  },
];

test("канонический хэш совпадает с эталонными векторами (JS ↔ SQL)", () => {
  for (const vector of VECTORS) {
    assert.equal(contentHash(vector.input), vector.expected, vector.title);
  }
});

test("sha256Hex побайтово совпадает с node:crypto", () => {
  const samples = [
    "",
    "a",
    "привет",
    "Милана и Толечка: тест",
    "\u0000бинарные\u007fсимволы",
    "😀 эмодзи в тексте",
    contentHashInput(VECTORS[0]!.input),
  ];

  for (const sample of samples) {
    const expected = createHash("sha256").update(sample, "utf8").digest("hex");
    assert.equal(sha256Hex(sample), expected, JSON.stringify(sample));
  }
});

test("нормализация текста повторяет btrim(replace(text, E'\\r\\n', E'\\n'))", () => {
  assert.equal(normalizeText("  текст  "), "текст");
  assert.equal(normalizeText("a\r\nb"), "a\nb");
  assert.equal(normalizeText("a\rb"), "a\nb");
  assert.equal(normalizeText("\r\n\r\n"), "");
  assert.equal(normalizeText(""), "");
});

test("время приводится к UTC с миллисекундами как в SQL to_char(...MS\"Z\")", () => {
  assert.equal(canonicalUtc("2026-01-02T18:30:00+03:00"), "2026-01-02T15:30:00.000Z");
  assert.equal(canonicalUtc("2026-10-15T10:30:00Z"), "2026-10-15T10:30:00.000Z");
  assert.throws(() => canonicalUtc("не дата"), /Некорректная дата/);
});

test("одобрение привязано к содержимому: любое изменение меняет хэш", () => {
  const base = { ...VECTORS[0]!.input };
  const original = contentHash(base);

  const changed = [
    { ...base, text: `${base.text}!` },
    { ...base, text: base.text.replace("\n", " \n") },
    { ...base, imagePath: "posts/another.png" },
    { ...base, imagePath: null },
    { ...base, scheduledAt: "2026-10-15T10:31:00.000Z" },
    { ...base, communityId: "life" },
  ];

  for (const variant of changed) {
    assert.notEqual(contentHash(variant), original, JSON.stringify(variant));
  }

  // Оформление, которое нормализуется (пробелы по краям, CRLF, другой часовой
  // пояс того же момента), не сбрасывает одобрение — иначе владельца дёргали бы зря.
  const cosmetic = [
    { ...base, text: `${base.text}   ` },
    { ...base, text: base.text.replace(/\r\n/g, "\n") },
    { ...base, scheduledAt: "2026-10-15T13:30:00+03:00" },
  ];

  for (const variant of cosmetic) {
    assert.equal(contentHash(variant), original, JSON.stringify(variant));
  }
});

test("короткая подпись не путается с полным хэшем", () => {
  assert.equal(shortHash(VECTORS[1]!.expected), "51102f73");
  assert.equal(shortHash(null), "");
  assert.equal(shortHash(""), "");
});
