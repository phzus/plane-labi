// Labi modification: browser E2E gate for Mensagens. See LABI-CHANGES.md.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  outputDir: "./artifacts/test-results",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "artifacts/results.json" }]],
  use: {
    baseURL: "http://localhost",
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  projects: [
    // Logins type throwaway passwords: no trace there, so nothing sensitive lands in the artifacts.
    { name: "login", testMatch: /login\.setup\.ts/, use: { trace: "off" } },
    { name: "chat", testMatch: /chat\.spec\.ts/, dependencies: ["login"] },
  ],
});
