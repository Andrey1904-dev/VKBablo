import { expect, test, type Page } from '@playwright/test';

// Browser-local demo fixtures only: no real Auth account, uploads or post actions.
test.skip(Boolean(process.env.PAGES_URL), 'Moderation fixtures are for the isolated local demo artifact');
const posts = Array.from({ length: 5 }, (_, i) => ({
  id: `moderation-fixture-${i + 1}`, communityId: i % 2 ? 'milana' : 'stories',
  status: i === 4 ? 'draft' : 'review', scheduledAt: `2026-10-${20 - i}T10:30:00.000Z`,
  title: `Материал ${i + 1}`, topic: 'Безопасная UI фикстура',
  text: i === 2 ? 'Текст материала 3. Тестовый пост с изображением. Выберите другой материал или вернитесь к списку — одобрение остаётся ручным.' : `Текст материала ${i + 1}. ` + 'Длинный текст для проверки чтения. '.repeat(25) + 'БезПробелов'.repeat(40),
  imagePath: 'demo-fixture.png', imagePrompt: '', idea: '', vkPostId: null,
  publishedAt: null, contentHash: '', approvedHash: null, approvedAt: null, approvedBy: null,
  errorMessage: null, generationMeta: null, similarityScore: null, similarTo: null,
  testMode: true, version: 1, createdAt: '2026-10-15T10:00:00.000Z', updatedAt: '2026-10-15T10:00:00.000Z',
}));

async function openQueue(page: Page, empty = false) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/*.supabase.co/**', route => route.abort());
  await page.addInitScript(items => localStorage.setItem('vkai-demo-store-v2', JSON.stringify({
    schema: 2, user: { id: 'ui-fixture-owner', name: 'UI Fixture', email: 'fixture@example.invalid', role: 'owner' }, posts: items,
  })), empty ? [] : posts);
  await page.goto('./#/posts');
  await expect(page.getByRole('heading', { name: 'На проверке', exact: true })).toBeVisible();
  return errors;
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

for (const width of [320, 375, 390, 760]) {
  test(`mobile moderation selection, navigation and filters at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const errors = await openQueue(page);
    const list = page.getByRole('complementary', { name: 'Публикации очереди' });
    const preview = page.getByRole('region', { name: 'Просмотр публикации' });
    await expect(page.getByText('4 ожидают решения', { exact: true })).toBeVisible();
    await expect(list.locator('button')).toHaveCount(5);
    await expect(list.locator('[aria-current="true"]')).toContainText('Материал 1');
    await expect(preview).toBeHidden();
    const avatar = list.locator('.avatar').first();
    expect(await avatar.evaluate(el => Math.abs(el.getBoundingClientRect().width - el.getBoundingClientRect().height))).toBeLessThan(1);
    await noOverflow(page);
    for (const i of [0, 2, 4]) {
      await list.getByRole('button', { name: new RegExp(`Материал ${i + 1}`) }).click();
      await expect(preview).toBeVisible();
      await expect(preview).toBeFocused();
      await expect(preview).toContainText(posts[i].text);
      await expect(page.getByRole('status')).toHaveText(`${i + 1} из 5`);
      await expect(preview.getByRole('img', { name: 'Изображение публикации' })).toBeVisible();
      await expect.poll(() => preview.getByRole('img', { name: 'Изображение публикации' }).evaluate(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0)).toBe(true);
      const previous = page.getByRole('button', { name: 'Предыдущая публикация' });
      if (i === 0) await expect(previous).toBeDisabled(); else await expect(previous).toBeEnabled();
      const next = page.getByRole('button', { name: 'Следующая публикация' });
      if (i === 4) await expect(next).toBeDisabled(); else await expect(next).toBeEnabled();
      await noOverflow(page);
      const approve = preview.getByRole('button', { name: 'Одобрить', exact: true });
      await approve.scrollIntoViewIfNeeded();
      expect(await approve.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
      await expect(preview.getByRole('button', { name: 'Отклонить', exact: true })).toBeVisible();
      if (i === 2 && width === 390) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: testInfo.outputPath('mobile-preview.png'), fullPage: true }); }
      await page.getByRole('button', { name: /^К списку/ }).click();
      await expect(list).toBeVisible();
      await expect(list.locator('[aria-current="true"]')).toContainText(`Материал ${i + 1}`);
    }
    await list.getByRole('button', { name: /Материал 3/ }).click();
    await page.getByRole('button', { name: 'Следующая публикация' }).click();
    await expect(preview).toContainText('Материал 4');
    await page.getByRole('button', { name: 'Предыдущая публикация' }).click();
    await expect(preview).toContainText('Материал 3');
    await page.getByRole('button', { name: 'Черновики', exact: true }).click();
    await expect(list).toBeVisible();
    await expect(list.locator('button')).toHaveCount(1);
    await list.getByRole('button').click();
    await expect(page.getByRole('status')).toHaveText('1 из 1');
    await expect(page.getByRole('button', { name: 'Предыдущая публикация' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Следующая публикация' })).toBeDisabled();
    await page.getByRole('button', { name: 'Опубликованы', exact: true }).click();
    await expect(page.getByText('Нет публикаций по выбранным фильтрам', { exact: true })).toBeVisible();
    await expect(preview).toHaveCount(0);
    await page.getByRole('button', { name: 'Все', exact: true }).click();
    await page.getByRole('combobox', { name: 'Сообщество' }).selectOption('milana');
    await expect(list.locator('button')).toHaveCount(2);
    await page.getByRole('combobox', { name: 'Сообщество' }).selectOption('');
    await expect(list.locator('button')).toHaveCount(5);
    const search = page.getByPlaceholder('Найти публикацию…');
    await search.fill('Материал 3'); await search.press('Enter');
    await expect(list.locator('button')).toHaveCount(1);
    await expect(search).toBeFocused();
    await search.fill('Нет такого материала'); await search.press('Enter');
    await expect(page.getByText('Нет публикаций по выбранным фильтрам', { exact: true })).toBeVisible();
    await search.fill(''); await search.press('Enter');
    await expect(list.locator('button')).toHaveCount(5);
    await noOverflow(page);
    if (width === 390) await page.screenshot({ path: testInfo.outputPath('mobile-list.png'), fullPage: true });
    expect(errors).toEqual([]);
  });
}

test('empty queue has a usable empty state', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const errors = await openQueue(page, true);
  await expect(page.getByText('Публикаций пока нет', { exact: true })).toBeVisible();
  await expect(page.getByText('0 ожидают решения', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /К списку|К просмотру/ })).toHaveCount(0);
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test('desktop keeps both columns and correct selected row', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Desktop layout');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = await openQueue(page);
  const list = page.locator('.review-list'); const preview = page.locator('.review-preview');
  await expect(list).toBeVisible(); await expect(preview).toBeVisible();
  await expect(page.locator('.review-mobile-controls')).toBeHidden();
  await expect(list.locator('.active')).toContainText('Материал 1');
  for (const i of [2, 4, 0]) {
    await list.getByRole('button', { name: new RegExp(`Материал ${i + 1}`) }).click();
    await expect(preview).toContainText(`Материал ${i + 1}`);
    await expect(list).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath('desktop-queue.png'), fullPage: true });
  expect(errors).toEqual([]);
});
