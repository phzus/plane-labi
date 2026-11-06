// Labi modification: browser E2E gate for Mensagens. See LABI-CHANGES.md.
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";

export const SLUG = "labi-e2e";
export const ROOT = path.resolve(__dirname, "..");
export const ART = path.join(ROOT, "artifacts");
export type TUser = "ana" | "bruno" | "carla" | "dani" | "gil";

export const users = (): Record<TUser, { email: string; first_name: string; password: string }> =>
  JSON.parse(fs.readFileSync(process.env.E2E_USERS_FILE as string, "utf8"));
export const authFile = (user: TUser) => path.join(ROOT, ".auth", `${user}.json`);
export const fullName = (user: TUser) => `${users()[user].first_name} Teste`;

/** Full-page screenshot saved under artifacts/screens and attached to the test result. */
export async function shot(page: Page, name: string) {
  const file = path.join(ART, "screens", `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await test.info().attach(name, { path: file, contentType: "image/png" });
}

const openPages: { user: string; page: Page }[] = [];

/** A separate browser context (own cookies) logged in as `user`. */
export async function as(browser: Browser, user: TUser, options: BrowserContextOptions = {}) {
  const context = await browser.newContext({ storageState: authFile(user), ...options });
  const page = await context.newPage();
  openPages.push({ user, page });
  return page;
}

test.afterEach(async ({}, testInfo) => {
  const pages = openPages.splice(0);
  for (const [i, { user, page }] of pages.entries()) {
    if (testInfo.status !== testInfo.expectedStatus && !page.isClosed()) {
      const slug = testInfo.title.split(":")[0].replace(/[^\w-]+/g, "-");
      await shot(page, `FAIL-${slug}-${i}-${user}`).catch(() => undefined);
    }
    await page.context().close().catch(() => undefined);
  }
});

// ---- locators (accessible names come from packages/i18n pt-BR `labi_messages`) ----
export const pill = (p: Page) => p.getByRole("button", { name: /^Abrir mensagens/ });
export const panel = (p: Page) => p.getByRole("dialog", { name: "Mensagens", exact: true });
export const sidebarItem = (p: Page) => p.locator(`a[href^="/${SLUG}/messages"]`).filter({ hasText: "Mensagens" });
export const composer = (scope: Page | ReturnType<Page["locator"]>) =>
  scope.getByRole("textbox", { name: "Mensagem…" });
export const log = (scope: Page | ReturnType<Page["locator"]>) => scope.getByRole("log");
export const bubble = (scope: Page | ReturnType<Page["locator"]>, text: string) =>
  log(scope).locator("div.group", { hasText: text }).last();

/** Unread conversations announced by the pill's accessible name ("Abrir mensagens (2 conversas não lidas)"). */
export async function pillUnread(p: Page) {
  const name = (await pill(p).getAttribute("aria-label")) ?? "";
  return Number(/\((\d+) conversas? não lidas?\)/.exec(name)?.[1] ?? 0);
}

/** Waits until the page's Mensagens WebSocket said "ready" (so later events cannot be missed). */
export function trackSocket(p: Page) {
  const frames: string[] = [];
  let ready = false;
  p.on("websocket", (ws) => {
    if (!ws.url().includes("/live/messages/")) return;
    ws.on("framereceived", (f) => {
      const payload = String(f.payload);
      frames.push(payload);
      if (payload.includes('"ready"')) ready = true;
    });
  });
  return { frames, waitReady: () => expect.poll(() => ready, { timeout: 20_000 }).toBe(true) };
}

/** Uses the "Nova conversa" dialog: picks people by first name, optional group name, "Conversar". */
export async function startConversation(p: Page, people: TUser[], groupName?: string) {
  const dialogInput = p.getByPlaceholder("Buscar pessoas…");
  await expect(dialogInput).toBeVisible();
  for (const person of people) {
    await dialogInput.fill(users()[person].first_name);
    await p.getByRole("checkbox", { name: new RegExp(fullName(person)) }).click();
  }
  await dialogInput.fill("");
  if (groupName) await p.getByPlaceholder("Nome do grupo (opcional)").fill(groupName);
  await p.getByRole("button", { name: "Conversar", exact: true }).click();
  await expect(dialogInput).toBeHidden();
}

/** Full-page Mensagens: opens the conversation named `title` from the list. */
export async function openFromList(p: Page, title: string) {
  if (!p.url().includes(`/${SLUG}/messages`)) await p.goto(`/${SLUG}/messages/`);
  await p.locator("aside").getByRole("button", { name: new RegExp(title) }).first().click();
  await expect(p.getByRole("heading", { level: 2, name: title })).toBeVisible();
  await expect(log(p)).toHaveAttribute("aria-busy", "false");
}

export async function send(scope: Page | ReturnType<Page["locator"]>, text: string) {
  const box = composer(scope);
  await box.fill(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
  await expect(bubble(scope, text)).toBeVisible();
}
