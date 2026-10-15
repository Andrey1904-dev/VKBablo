import { expect, test } from "@playwright/test";

const pagesBackendMode = process.env.PAGES_BACKEND_MODE ?? "demo";
const hasPublicSupabaseConfig = process.env.PAGES_HAS_SUPABASE === "true";
const isSupabasePagesBuild = hasPublicSupabaseConfig && ["auto", "supabase"].includes(pagesBackendMode);

// Every context is isolated. The demo smoke may create only a browser-local demo owner;
// a Supabase-configured deployment is checked read-only and never creates a real account.
for (const storage of ["available", "denied", "quota-exceeded"] as const) {
  test(`production UI renders with storage ${storage}`, async ({ page, baseURL }, testInfo) => {
    const errors: string[] = [];
    const assets: { url: string; status: number; type: string }[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("response", (response) => {
      if (/\.(js|css)(?:\?|$)/.test(response.url()) && response.url().startsWith(new URL(baseURL!).origin)) {
        assets.push({ url: response.url(), status: response.status(), type: response.headers()["content-type"] || "" });
      }
    });
    page.on("requestfailed", (request) => errors.push(`Request failed: ${request.url()}`));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(baseURL!).origin && !/^\/(api|uploads)(\/|$)/.test(url.pathname)) {
        return route.continue();
      }
      // setup-state is public and read-only; allow the deployed backend to report
      // whether an owner already exists. Other cloud operations stay blocked.
      if (isSupabasePagesBuild && url.pathname === "/functions/v1/vk-ai-api/setup-state" &&
          url.hostname === "rxzpgxejhfubenllfrpb.supabase.co") return route.continue();
      // Fonts are optional; prevent external calls rather than exercising integrations.
      if (url.hostname === "fonts.googleapis.com") return route.fulfill({ contentType: "text/css", body: "" });
      errors.push(`Unexpected external/API request: ${url}`);
      return route.fulfill({ status: 403, body: "Blocked by smoke test" });
    });
    if (storage !== "available") {
      await page.addInitScript((mode) => {
        if (mode === "denied") {
          Object.defineProperty(window, "localStorage", {
            get() { throw new DOMException("Storage denied", "SecurityError"); },
          });
        } else {
          Storage.prototype.setItem = () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); };
        }
      }, storage);
    }
    const setupState = isSupabasePagesBuild
      ? page.waitForResponse(response => response.url() === "https://rxzpgxejhfubenllfrpb.supabase.co/functions/v1/vk-ai-api/setup-state")
      : null;
    await page.goto("./");
    if (setupState) {
      const response = await setupState;
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({ hasOwner: true });
    }
    if (process.env.PAGES_EXPECTED_SHA) {
      // CDN can still serve the previous deployment. Reload until this revision is visible.
      await expect(async () => {
        // Finish startup API requests before navigating. WebKit reports a reload
        // that interrupts setup-state as a network failure even after HTTP 200.
        await page.waitForLoadState("networkidle");
        const revision = page.locator('meta[name="vkbablo-build"]');
        if (await revision.getAttribute("content") !== process.env.PAGES_EXPECTED_SHA) {
          await page.reload();
          await page.waitForLoadState("networkidle");
        }
        await expect(revision).toHaveAttribute("content", process.env.PAGES_EXPECTED_SHA!, { timeout: 1000 });
      }).toPass({ timeout: 120_000, intervals: [5000, 10000] });
    }
    await expect(page.getByRole("heading", {
      name: isSupabasePagesBuild ? "Вход в панель" : "Создание владельца",
      exact: true,
    })).toBeVisible();
    await expect(page.locator(".login-card")).toHaveCSS("background-color", /rgb/);
    expect(await page.locator(".login-card").evaluate((el) => getComputedStyle(el).borderRadius)).not.toBe("0px");
    if (isSupabasePagesBuild) {
      // Read-only cloud smoke only. Never create an Auth account or call any protected API.
      // This deployment targets the existing test owner; bootstrap is a failure.
      await expect(page.getByRole("button", { name: "Создать аккаунт", exact: true })).toHaveCount(0);
    } else {
      await page.locator('input[type="email"]').fill("pages-smoke@example.invalid");
      await page.locator('input[type="password"]').fill("demo-only-123456");
      await page.getByRole("button", { name: "Создать аккаунт", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Обзор", exact: true })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await expect(page.getByText("Демонстрационное пространство", { exact: false })).toBeVisible();
      await expect(page.locator(".stats-grid")).toBeVisible();
      if (storage === "available") {
        // A saved demo owner must survive a fresh entry at a nested hash route.
        await page.goto("./#/communities");
        await expect(page.getByRole("heading", { name: "Сообщества", exact: true })).toBeVisible();
        // Finish cover downloads before reload; WebKit reports interrupted images as failures.
        await expect.poll(() => page.locator("img.cover").evaluateAll(images =>
          images.length === 4 && images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)
        )).toBe(true);
        await page.reload();
        await expect(page.getByRole("heading", { name: "Сообщества", exact: true })).toBeVisible();
      }
    }
    await expect(page.locator(".startup-error")).toHaveCount(0);
    const js = assets.filter((asset) => asset.url.includes("/assets/") && asset.url.includes(".js"));
    const css = assets.filter((asset) => asset.url.includes("/assets/") && asset.url.includes(".css"));
    expect(js.length).toBeGreaterThan(0);
    expect(css.length).toBeGreaterThan(0);
    for (const asset of [...js, ...css]) {
      expect(asset.status, asset.url).toBe(200);
      expect(asset.type, asset.url).toMatch(asset.url.includes(".js") ? /javascript/ : /text\/css/);
      expect(new URL(asset.url).pathname, asset.url).toMatch(/^\/VKBablo\/assets\//);
    }
    expect(errors).toEqual([]);
    await testInfo.attach("rendered-interface", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  });
}
