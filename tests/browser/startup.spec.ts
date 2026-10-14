import { expect, test } from "@playwright/test";

// Fault injection is for the local artifact only, not the deployed-site smoke check.
test.skip(Boolean(process.env.PAGES_URL), "Local fault-injection tests");

test("a failed React chunk shows recovery UI", async ({ page }) => {
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ contentType: "text/css", body: "" }));
  await page.route("**/assets/main-*.js", (route) => route.fulfill({ status: 503, contentType: "text/javascript", body: "" }));
  await page.goto("./");
  await expect(page.getByRole("alert")).toContainText("Не удалось запустить VKBablo");
  await expect(page.getByRole("button", { name: "Обновить страницу" })).toBeVisible();
});

test("a React render exception shows recovery UI without clearing stored data", async ({ page }) => {
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ contentType: "text/css", body: "" }));
  await page.addInitScript(() => {
    // Deliberately malformed old demo user: AppShell's name.split will throw.
    localStorage.setItem("vkai-demo-store-v2", JSON.stringify({ schema: 2, user: { id: "broken-demo", email: "test@example.invalid", name: null, role: "owner" } }));
  });
  await page.goto("./");
  await expect(page.getByRole("alert")).toContainText("Не удалось открыть VKBablo");
  await expect(page.getByRole("button", { name: "Обновить страницу" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("vkai-demo-store-v2"))).toContain("broken-demo");
});
