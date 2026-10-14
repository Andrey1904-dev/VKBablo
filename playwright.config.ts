import { defineConfig, devices } from "@playwright/test";

const remoteURL = process.env.PAGES_URL;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const chromiumLaunch = executablePath ? { executablePath, args: ["--no-sandbox", "--no-zygote", "--use-angle=swiftshader"] } : {};

export default defineConfig({
  testDir: "./tests/browser",
  timeout: remoteURL ? 180_000 : 45_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: remoteURL ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: remoteURL || "http://127.0.0.1:5173/VKBablo/",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: chromiumLaunch,
      },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["iPhone 13"], browserName: "chromium", launchOptions: chromiumLaunch },
    },
    { name: "iphone-webkit", use: { ...devices["iPhone 13"], browserName: "webkit" } },
  ],
  webServer: remoteURL ? undefined : {
    command: "npm run preview:pages -- --strictPort",
    url: "http://127.0.0.1:5173/VKBablo/",
    reuseExistingServer: !process.env.CI,
  },
});
