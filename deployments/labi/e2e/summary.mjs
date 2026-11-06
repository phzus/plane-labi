// Labi modification: turns artifacts/results.json (Playwright JSON reporter) into artifacts/summary.md.
import fs from "node:fs";

const ART = new URL("./artifacts/", import.meta.url);
const results = JSON.parse(fs.readFileSync(new URL("results.json", ART), "utf8"));

const rows = [];
const walk = (suite) => {
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests) {
      const last = t.results.at(-1) ?? { status: "skipped", attachments: [] };
      // Screenshots are attached under their artifacts/screens name; traces/error-context keep theirs.
      const evidence = last.attachments.map((a) => (a.contentType === "image/png" ? `${a.name}.png` : a.name));
      const error = (last.errors ?? [])
        .map((e) => (e.message ?? "").replace(/\x1b\[[0-9;]*m/g, "").split("\n").slice(0, 2).join(" "))
        .join(" / ");
      rows.push({ title: spec.title, status: last.status === "passed" ? "PASS" : "FAIL", evidence, error });
    }
  }
  (suite.suites ?? []).forEach(walk);
};
results.suites.forEach(walk);

const md = [
  "# E2E Mensagens — resultado",
  "",
  `Stack: ${process.env.LABI_IMAGE_PREFIX ?? "?"} @ ${process.env.LABI_TAG ?? "?"} — ${new Date().toISOString()}`,
  "",
  "| Teste | Resultado | Evidências | Erro |",
  "|---|---|---|---|",
  ...rows.map(
    (r) => `| ${r.title} | **${r.status}** | ${r.evidence.join("<br>")} | ${r.error.replace(/\|/g, "\\|").slice(0, 500)} |`
  ),
  "",
  `Total: ${rows.filter((r) => r.status === "PASS").length}/${rows.length} PASS`,
  "",
  "Notas: `a11y-*.json` lista violações dentro do chat (`chat`) e, só como nota, as do Plane upstream fora dele (`upstreamNotes`).",
  "",
].join("\n");
fs.writeFileSync(new URL("summary.md", ART), md);
console.log(md);
process.exit(rows.length > 0 && rows.every((r) => r.status === "PASS") ? 0 : 1);
