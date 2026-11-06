// Labi modification: browser E2E gate for Mensagens (spec 04, AC-1..AC-6). See LABI-CHANGES.md.
// Tests run in file order on one worker; each opens its own logged-in contexts (one per person).
import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import WebSocket from "ws";
import {
  ART,
  as,
  authFile,
  bubble,
  composer,
  fullName,
  log,
  openFromList,
  panel,
  pill,
  pillUnread,
  send,
  shot,
  sidebarItem,
  SLUG,
  startConversation,
  trackSocket,
} from "./helpers";

const API = `/api/workspaces/${SLUG}/messages`;
const GROUP = "E2E Grupo";
const RUN = Date.now().toString(36);

test("AC-5 (balão): painel abre, fecha, Esc fecha, expandir leva à mesma conversa; balão some na tela inteira", async ({
  browser,
}) => {
  const ana = await as(browser, "ana");
  await ana.goto(`/${SLUG}/`);
  await expect(pill(ana)).toBeVisible();
  const box = (await pill(ana).boundingBox())!;
  const vp = ana.viewportSize()!;
  expect(box.x + box.width, "balão no canto direito").toBeGreaterThan(vp.width - 48);
  expect(box.y + box.height, "balão no canto inferior").toBeGreaterThan(vp.height - 48);
  await shot(ana, "ac5-01-ana-home-balao-canto-inferior-direito");

  await ana.goto(`/${SLUG}/notifications/`);
  await pill(ana).click();
  await expect(panel(ana)).toBeVisible();
  await shot(ana, "ac5-03-balao-abre-painel");
  await ana.keyboard.press("Escape");
  await expect(panel(ana)).toBeHidden();
  await expect(pill(ana)).toBeVisible();
  await shot(ana, "ac5-04-esc-fecha-painel");

  await pill(ana).click();
  await panel(ana).getByRole("button", { name: "Fechar" }).click();
  await expect(panel(ana)).toBeHidden();

  await pill(ana).click();
  await panel(ana).getByRole("button", { name: "Nova conversa" }).click();
  await startConversation(ana, ["carla"]);
  await expect(panel(ana).getByRole("heading", { level: 2, name: fullName("carla") })).toBeVisible();
  await shot(ana, "ac5-05-conversa-aberta-no-painel");
  await panel(ana).getByRole("button", { name: "Abrir em tela cheia" }).click();
  await expect(ana).toHaveURL(new RegExp(`/${SLUG}/messages/[0-9a-f-]{36}/?$`));
  await expect(ana.getByRole("heading", { level: 2, name: fullName("carla") })).toBeVisible();
  await expect(composer(ana)).toBeVisible();
  await expect(pill(ana)).toHaveCount(0);
  await shot(ana, "ac5-06-expandir-leva-a-mesma-conversa");
});

test("AC-1 + AC-4: conversa direta em tempo real, badge, Visto e Shift+Enter", async ({ browser }) => {
  const ana = await as(browser, "ana");
  const bruno = await as(browser, "bruno");
  const brunoSocket = trackSocket(bruno);
  await bruno.goto(`/${SLUG}/`);
  await expect(pill(bruno)).toBeVisible();
  await brunoSocket.waitReady();
  await bruno.evaluate(() => ((window as unknown as { __e2eNoReload: boolean }).__e2eNoReload = true));
  const before = await pillUnread(bruno);
  await shot(bruno, "ac1-01-bruno-antes-sem-nao-lidas");

  await ana.goto(`/${SLUG}/messages/`);
  await ana.getByRole("button", { name: "Nova conversa" }).first().click();
  await startConversation(ana, ["bruno"]);
  await expect(ana.getByRole("heading", { level: 2, name: fullName("bruno") })).toBeVisible();
  const first = `Oi Bruno, mensagem E2E ${RUN}`;
  await send(ana, first);
  await shot(ana, "ac1-02-ana-enviou-com-enter");

  // Real time, no reload: the badge on the pill and on the sidebar goes up within seconds.
  await expect(pill(bruno)).toHaveAttribute("aria-label", new RegExp(`\\(${before + 1} conversas? não lidas?\\)`), {
    timeout: 5_000,
  });
  await shot(bruno, "ac1-03-ac4-bruno-badge-do-balao-subiu-sem-recarregar");

  await pill(bruno).click();
  await panel(bruno).getByRole("button", { name: new RegExp(fullName("ana")) }).first().click();
  await expect(bubble(panel(bruno), first)).toBeVisible();
  await shot(bruno, "ac1-04-bruno-ve-a-mensagem");

  // AC-4: opening zeroes the badge; Ana sees "Visto" under her last message.
  await expect(ana.getByText(/^Visto/)).toBeVisible({ timeout: 10_000 });
  await shot(ana, "ac4-01-ana-ve-visto");

  // Shift+Enter = newline; Enter = send. Bruno has the conversation open and sees it live.
  const box = composer(ana);
  await box.click();
  await box.pressSequentially(`linha 1 ${RUN}`);
  await box.press("Shift+Enter");
  await box.pressSequentially("linha 2");
  await expect(box).toHaveValue(`linha 1 ${RUN}\nlinha 2`);
  await box.press("Enter");
  await expect(box).toHaveValue("");
  const multi = bubble(panel(bruno), `linha 1 ${RUN}`);
  await expect(multi).toBeVisible({ timeout: 5_000 });
  expect(await multi.innerText()).toMatch(new RegExp(`linha 1 ${RUN}\\s*\\n\\s*linha 2`));
  await shot(bruno, "ac1-05-shift-enter-quebra-linha-ao-vivo");

  const reply = `Oi Ana, resposta do Bruno ${RUN}`;
  await send(panel(bruno), reply);
  await expect(bubble(ana, reply)).toBeVisible({ timeout: 5_000 });
  await shot(ana, "ac1-06-ana-recebe-resposta-ao-vivo");

  // Esc from inside an open conversation (focus is in the composer) closes the panel.
  await expect(composer(panel(bruno))).toBeFocused();
  await bruno.keyboard.press("Escape");
  await expect(panel(bruno)).toBeHidden();
  await expect(pill(bruno)).toBeVisible();
  expect(await pillUnread(bruno)).toBe(before);
  expect(await bruno.evaluate(() => (window as unknown as { __e2eNoReload?: boolean }).__e2eNoReload)).toBe(true);
  await shot(bruno, "ac4-02-bruno-badge-zerado-no-balao");
});

test("AC-5 + AC-4 (menu lateral): item Mensagens leva à tela inteira e mostra a badge de não lidas", async ({
  browser,
}) => {
  const bruno = await as(browser, "bruno");
  await bruno.goto(`/${SLUG}/`);
  await expect(pill(bruno)).toBeVisible();
  await shot(bruno, "menu-01-bruno-menu-lateral");
  await expect(sidebarItem(bruno), "item 'Mensagens' no menu lateral do workspace").toBeVisible();

  const ana = await as(browser, "ana");
  await openFromList(ana, fullName("bruno"));
  await send(ana, `Badge do menu ${RUN}`);
  await expect(sidebarItem(bruno)).toContainText(/\d/, { timeout: 5_000 });
  await shot(bruno, "menu-02-badge-no-menu-lateral");
  await sidebarItem(bruno).click();
  await expect(bruno).toHaveURL(new RegExp(`/${SLUG}/messages/?$`));
  await expect(bruno.getByRole("heading", { level: 1, name: "Mensagens" })).toBeVisible();
  await expect(pill(bruno)).toHaveCount(0);
  await shot(bruno, "menu-03-menu-abre-tela-inteira");
});

test("AC-2: grupo fechado — fora do grupo recebe 404 e nada no WebSocket; convidado recebe 403", async ({
  browser,
}) => {
  const ana = await as(browser, "ana");
  const bruno = await as(browser, "bruno");
  const carla = await as(browser, "carla");
  const carlaSocket = trackSocket(carla);
  await carla.goto(`/${SLUG}/messages/`);
  await carlaSocket.waitReady();

  await ana.goto(`/${SLUG}/messages/`);
  await ana.getByRole("button", { name: "Nova conversa" }).first().click();
  await startConversation(ana, ["bruno", "dani"], GROUP);
  await expect(ana.getByRole("heading", { level: 2, name: GROUP })).toBeVisible();
  const groupId = /messages\/([0-9a-f-]{36})/.exec(ana.url())![1];
  const text = `Mensagem do grupo ${RUN}`;
  await send(ana, text);
  await shot(ana, "ac2-01-ana-criou-grupo-e-enviou");

  await bruno.goto(`/${SLUG}/messages/`);
  await openFromList(bruno, GROUP);
  await expect(bubble(bruno, text)).toBeVisible();
  await shot(bruno, "ac2-02-bruno-membro-ve-o-grupo");

  const detail = await carla.request.get(`${API}/conversations/${groupId}/`);
  expect(detail.status(), "Carla (fora do grupo) GET conversa").toBe(404);
  const messages = await carla.request.get(`${API}/conversations/${groupId}/messages/`);
  expect(messages.status(), "Carla (fora do grupo) GET mensagens").toBe(404);
  const list = await carla.request.get(`${API}/conversations/`);
  expect(list.status()).toBe(200);
  expect(await list.text()).not.toContain(groupId);
  await carla.reload();
  await expect(carla.getByRole("heading", { level: 1, name: "Mensagens" })).toBeVisible();
  await expect(carla.getByText("Carregando…")).toHaveCount(0);
  await expect(carla.getByText(GROUP)).toHaveCount(0);
  expect(carlaSocket.frames.join("\n"), "nenhum evento do grupo no WebSocket da Carla").not.toContain(groupId);
  await shot(carla, "ac2-03-carla-nao-ve-o-grupo");
  await carla.goto(`/${SLUG}/messages/${groupId}`);
  await expect(carla.getByText(text)).toHaveCount(0);
  await shot(carla, "ac2-04-carla-link-direto-sem-conteudo");

  const gil = await as(browser, "gil");
  const guestList = await gil.request.get(`${API}/conversations/`);
  expect(guestList.status(), "convidado GET lista").toBe(403);
  await gil.goto(`/${SLUG}/`);
  await expect(gil.getByText("Labi E2E").first()).toBeVisible();
  await gil.waitForLoadState("networkidle");
  await expect(sidebarItem(gil)).toHaveCount(0);
  await expect(pill(gil)).toHaveCount(0);
  await shot(gil, "ac2-05-convidado-sem-menu-e-sem-balao");
  await gil.goto(`/${SLUG}/messages/`);
  await expect(gil.getByText("Sem acesso às mensagens")).toBeVisible();
  await shot(gil, "ac2-06-convidado-tela-sem-acesso");
});

async function fixtures(page: Page) {
  const dir = path.join(ART, "fixtures");
  fs.mkdirSync(dir, { recursive: true });
  await page.setContent(
    '<div id="f" style="width:160px;height:100px;background:linear-gradient(90deg,#e11d48,#2563eb)"></div>'
  );
  const png = await page.locator("#f").screenshot();
  await page.setContent("<h1>Labi E2E PDF</h1><p>anexo de teste</p>");
  const pdf = await page.pdf({ width: "300px", height: "200px" });
  fs.writeFileSync(path.join(dir, "e2e-imagem.png"), png);
  fs.writeFileSync(path.join(dir, "e2e-documento.pdf"), pdf);
  return { png, pdf, pngPath: path.join(dir, "e2e-imagem.png"), pdfPath: path.join(dir, "e2e-documento.pdf") };
}

test("AC-3: imagem e PDF aparecem e baixam; fora do grupo recebe 404 no download", async ({ browser }) => {
  const scratch = await (await browser.newContext()).newPage();
  const f = await fixtures(scratch);
  await scratch.context().close();

  const ana = await as(browser, "ana");
  await openFromList(ana, GROUP);
  await ana.locator('input[type="file"]').setInputFiles([f.pngPath, f.pdfPath]);
  await expect(ana.getByRole("button", { name: "Enviar" })).toBeEnabled({ timeout: 30_000 });
  const caption = `Anexos do E2E ${RUN}`;
  await send(ana, caption);
  await expect(ana.locator('img[alt="e2e-imagem.png"]')).toBeVisible();
  await shot(ana, "ac3-01-ana-enviou-imagem-e-pdf");

  const bruno = await as(browser, "bruno");
  await openFromList(bruno, GROUP);
  const img = bruno.locator('img[alt="e2e-imagem.png"]').last();
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  const card = bruno.getByRole("link", { name: "Baixar e2e-documento.pdf" }).last();
  await expect(card).toBeVisible();
  await expect(card).toContainText("e2e-documento.pdf");
  await shot(bruno, "ac3-02-bruno-ve-miniatura-e-cartao");

  const [download] = await Promise.all([bruno.waitForEvent("download"), card.click()]);
  expect(download.suggestedFilename()).toBe("e2e-documento.pdf");
  const got = fs.readFileSync((await download.path())!);
  expect(Buffer.compare(got, f.pdf), "bytes do PDF baixado = enviado").toBe(0);
  const imageHref = (await img.getAttribute("src"))!;
  const imageBytes = await (await bruno.request.get(imageHref)).body();
  expect(Buffer.compare(imageBytes, f.png), "bytes da imagem = enviada").toBe(0);
  await shot(bruno, "ac3-03-bruno-baixou-pdf");

  const carla = await as(browser, "carla");
  const pdfHref = (await card.getAttribute("href"))!;
  for (const href of [pdfHref, imageHref]) {
    const res = await carla.request.get(href, { maxRedirects: 0 });
    expect(res.status(), `Carla GET ${href}`).toBe(404);
  }
  fs.writeFileSync(
    path.join(ART, "ac3-carla-404.txt"),
    `Carla (fora do grupo) -> 404\n${pdfHref}\n${imageHref}\n`
  );
});

test("Responder e apagar: citação visível e 'Mensagem apagada' para todos", async ({ browser }) => {
  const ana = await as(browser, "ana");
  const bruno = await as(browser, "bruno");
  await openFromList(ana, GROUP);
  await openFromList(bruno, GROUP);
  const quoted = `Mensagem para citar ${RUN}`;
  const doomed = `Mensagem que será apagada ${RUN}`;
  await send(ana, quoted);
  await send(ana, doomed);
  await expect(bubble(bruno, doomed)).toBeVisible({ timeout: 5_000 });

  const target = bubble(bruno, quoted);
  await target.hover();
  await target.getByRole("button", { name: "Responder" }).click();
  await expect(bruno.getByText(`Respondendo a ${fullName("ana")}`)).toBeVisible();
  const answer = `Respondendo com citação ${RUN}`;
  await send(bruno, answer);
  await expect(bubble(bruno, answer)).toContainText(quoted);
  await expect(bubble(ana, answer)).toContainText(quoted, { timeout: 5_000 });
  await shot(ana, "reply-01-ana-ve-citacao");

  const mine = bubble(ana, doomed);
  await mine.hover();
  await mine.getByRole("button", { name: "Apagar" }).click();
  await ana.getByRole("dialog").getByRole("button", { name: "Apagar" }).click();
  for (const page of [ana, bruno]) {
    await expect(log(page).getByText(doomed)).toHaveCount(0, { timeout: 5_000 });
    await expect(log(page).getByText("Mensagem apagada").first()).toBeVisible();
  }
  await shot(ana, "delete-01-ana-mensagem-apagada");
  await shot(bruno, "delete-02-bruno-ve-mensagem-apagada");
});

test("AC-6: no celular (390x844) o painel ocupa a tela e o compositor aparece", async ({ browser }) => {
  const ana = await as(browser, "ana", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ana.goto(`/${SLUG}/notifications/`);
  await pill(ana).click();
  const box = (await panel(ana).boundingBox())!;
  expect(box.x).toBeLessThanOrEqual(1);
  expect(box.y).toBeLessThanOrEqual(1);
  expect(box.width).toBeGreaterThanOrEqual(389);
  expect(box.height).toBeGreaterThanOrEqual(843);
  await expect(panel(ana)).toHaveAttribute("aria-modal", "true");
  await shot(ana, "ac6-01-celular-painel-tela-cheia");
  await panel(ana).getByRole("button", { name: new RegExp(GROUP) }).first().click();
  await expect(composer(panel(ana))).toBeInViewport();
  await shot(ana, "ac6-02-celular-conversa-com-compositor");
  await panel(ana).getByRole("button", { name: "Fechar" }).click();
  await expect(panel(ana)).toBeHidden();
});

async function axeChat(page: Page, include: string, name: string) {
  const inside = await new AxeBuilder({ page }).include(include).analyze();
  const outside = await new AxeBuilder({ page }).exclude(include).analyze();
  const pick = (v: typeof inside.violations) =>
    v.map((x) => ({ id: x.id, impact: x.impact, help: x.help, nodes: x.nodes.map((n) => n.target.join(" ")) }));
  fs.writeFileSync(
    path.join(ART, `a11y-${name}.json`),
    JSON.stringify({ chat: pick(inside.violations), upstreamNotes: pick(outside.violations) }, null, 2)
  );
  await test.info().attach(`a11y-${name}.json`, { path: path.join(ART, `a11y-${name}.json`) });
  return pick(inside.violations).filter((v) => v.impact === "serious" || v.impact === "critical");
}

test("A11y: axe sem violações sérias/críticas na tela inteira e no painel", async ({ browser }) => {
  const ana = await as(browser, "ana");
  await openFromList(ana, GROUP);
  await ana.evaluate(() => {
    const aside = Array.from(document.querySelectorAll("aside")).find((a) => a.querySelector("h1"));
    aside?.parentElement?.setAttribute("data-e2e-chat-root", "");
  });
  await expect(ana.locator("[data-e2e-chat-root]")).toHaveCount(1);
  await shot(ana, "a11y-01-tela-inteira");
  const page = await axeChat(ana, "[data-e2e-chat-root]", "tela-inteira");

  await ana.goto(`/${SLUG}/notifications/`);
  await pill(ana).click();
  await panel(ana).getByRole("button", { name: new RegExp(GROUP) }).first().click();
  await expect(composer(panel(ana))).toBeVisible();
  await shot(ana, "a11y-02-painel");
  const floating = await axeChat(ana, '[role="dialog"][aria-label="Mensagens"]', "painel");
  expect({ telaInteira: page, painel: floating }).toEqual({ telaInteira: [], painel: [] });
});

test("Segurança: WebSocket sem cookie fecha 4401; origem estranha fecha 4403", async () => {
  const state = JSON.parse(fs.readFileSync(authFile("ana"), "utf8")) as { cookies: { name: string; value: string }[] };
  const cookie = state.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const connect = (headers: Record<string, string>) =>
    new Promise<{ code: number; frames: string[] }>((resolve, reject) => {
      const frames: string[] = [];
      const ws = new WebSocket("ws://localhost/live/messages/", { headers });
      ws.on("message", (d) => {
        frames.push(String(d));
        ws.close(1000);
      });
      ws.on("close", (code) => resolve({ code, frames }));
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 15_000);
    });

  const noCookie = await connect({ Origin: "http://localhost" });
  const evil = await connect({ Origin: "http://evil.example", Cookie: cookie });
  const good = await connect({ Origin: "http://localhost", Cookie: cookie });
  const report = { noCookie: noCookie.code, evilOrigin: evil.code, validSession: good };
  fs.writeFileSync(path.join(ART, "security-websocket.json"), JSON.stringify(report, null, 2));
  await test.info().attach("security-websocket.json", { path: path.join(ART, "security-websocket.json") });
  expect(noCookie.code).toBe(4401);
  expect(evil.code).toBe(4403);
  expect(good.frames[0], "controle positivo: sessão válida recebe 'ready'").toContain('"ready"');
});
