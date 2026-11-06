// Labi modification: browser E2E gate for Mensagens. See LABI-CHANGES.md.
// Real UI login (email -> password) for every seeded account, each in its own browser context.
import { expect, test } from "@playwright/test";
import { authFile, shot, SLUG, users, type TUser } from "./helpers";

for (const user of ["ana", "bruno", "carla", "dani", "gil"] as TUser[]) {
  test(`login: ${user} entra pela tela de login`, async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const { email, password } = users()[user];
    await page.goto("/");
    await page.locator("#email").fill(email);
    await page.locator("button[type=submit]").click();
    await page.locator("#password").fill(password);
    await page.locator("button[type=submit]").click();
    await page.waitForURL(new RegExp(`/${SLUG}(/|$)`), { timeout: 60_000 });
    await expect(page.getByText("Labi E2E").first()).toBeVisible();
    if (user === "ana" || user === "bruno") await shot(page, `login-${user}-workspace`);
    await context.storageState({ path: authFile(user) });
    await context.close();
  });
}
