// ВНИМАНИЕ: файл сгенерирован из shared/ командой `npm run sync:shared`.
// Правки вносите в источник: shared/<имя>.ts
/** Fixed-work secret comparison for one-time setup credentials. */
const MAX_SECRET_LENGTH = 256;

export function constantTimeTextEqual(left: string, right: string): boolean {
  const withinLimit = left.length <= MAX_SECRET_LENGTH && right.length <= MAX_SECRET_LENGTH;
  let difference = (left.length ^ right.length) | Number(!withinLimit);
  for (let index = 0; index < MAX_SECRET_LENGTH; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
