#!/usr/bin/env node
/**
 * Синхронизация изоморфного ядра `shared/*.ts` → `supabase/functions/_shared/core/`.
 *
 * Deno (Edge Functions) не умеет импортировать файлы за пределами каталога функции,
 * поэтому ядро копируется. Один источник истины — каталог `shared/`.
 * CI проверяет, что копия актуальна (`npm run check:shared`).
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "shared");
const target = join(root, "supabase", "functions", "_shared", "core");

const HEADER = `// ВНИМАНИЕ: файл сгенерирован из shared/ командой \`npm run sync:shared\`.
// Правки вносите в источник: shared/<имя>.ts
`;

mkdirSync(target, { recursive: true });

const files = readdirSync(source).filter((name) => name.endsWith(".ts"));
const check = process.argv.includes("--check");
let drift = 0;

for (const name of files) {
  const from = join(source, name);
  const to = join(target, name);
  const content = `${HEADER}${readFileSync(from, "utf8")}`;

  let current = "";
  try {
    current = readFileSync(to, "utf8");
  } catch {
    current = "";
  }

  if (check) {
    if (current !== content) {
      console.error(`✖ устарело: supabase/functions/_shared/core/${name}`);
      drift += 1;
    }
    continue;
  }

  if (current !== content) {
    writeFileSync(to, content, "utf8");
    console.log(`✔ обновлено: supabase/functions/_shared/core/${name}`);
  }
}

if (check) {
  if (drift > 0) {
    console.error(`\nЯдро Edge Functions отстало от shared/ (${drift} файл(ов)). Выполните: npm run sync:shared`);
    process.exit(1);
  }
  console.log(`✔ ядро синхронно (${files.length} файлов)`);
} else {
  console.log(`Синхронизировано файлов: ${files.length}`);
}

// Проверяем, что ядро не тянет Node/Deno-специфичные API (оно должно быть изоморфным).
const forbidden = [/from\s+["']node:/, /Deno\./, /process\.env/, /require\(/];
for (const name of files) {
  const content = readFileSync(join(source, name), "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(content)) {
      console.error(`✖ shared/${name} содержит несовместимый с браузером/Deno API: ${pattern}`);
      process.exit(1);
    }
  }
}
console.log("✔ ядро изоморфно (нет node:/Deno/process)");
