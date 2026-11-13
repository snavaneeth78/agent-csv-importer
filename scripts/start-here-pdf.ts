/**
 * Renders START-HERE.md to a one-page PDF with headless Chrome, for reviewers who open the submission folder in
 * Google Drive (which shows .md as plain text). Handles only the Markdown START-HERE.md uses.
 * Run: npx tsx scripts/start-here-pdf.ts [out.pdf]   (CHROME=/path/to/chrome to override the browser)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2] ?? "START-HERE.pdf");
const chrome = [process.env.CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"]
  .find((c) => c && existsSync(c));
if (!chrome) { console.error("start-here-pdf: no Chrome found (set CHROME=...); skipping the PDF"); process.exit(2); }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Inline Markdown. Relative links become plain text: they point at files in the folder, which a PDF can't open. */
function inline(s: string): string {
  const codes: string[] = [];
  s = esc(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, h) => (/^https?:/.test(h) ? `<a href="${h}">${t}</a>` : `<span class="path">${t}</span>`))
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]*[^\s<).,;:])/g, '$1<a href="$2">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

const lines = readFileSync("START-HERE.md", "utf8").split("\n");
const html: string[] = [];
for (let i = 0; i < lines.length;) {
  const l = lines[i];
  if (!l.trim()) { i++; continue; }
  if (l.startsWith("```")) {
    const body: string[] = [];
    for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
    html.push(`<pre>${esc(body.join("\n"))}</pre>`); i++; continue;
  }
  const h = /^(#{1,3}) (.*)/.exec(l);
  if (h) { html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
  if (l.startsWith("|")) {
    const rows: string[][] = [];
    for (; i < lines.length && lines[i].startsWith("|"); i++) if (!/^\|[-| ]+\|$/.test(lines[i])) rows.push(lines[i].slice(1, -1).split("|").map((c) => c.trim()));
    const [head, ...body] = rows;
    html.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    continue;
  }
  const list = /^(\d+\.|-) /.exec(l);
  if (list) {
    const tag = list[1] === "-" ? "ul" : "ol";
    const items: string[] = [];
    for (; i < lines.length && /^(\d+\.|-) /.test(lines[i]); i++) {
      let item = lines[i].replace(/^(\d+\.|-) /, "");
      while (i + 1 < lines.length && /^ {2,}\S/.test(lines[i + 1])) item += " " + lines[++i].trim();
      items.push(`<li>${inline(item)}</li>`);
    }
    html.push(`<${tag}>${items.join("")}</${tag}>`); continue;
  }
  const para: string[] = [];
  for (; i < lines.length && lines[i].trim() && !/^(#|\||```|\d+\. |- )/.test(lines[i]); i++) para.push(lines[i]);
  html.push(`<p>${inline(para.join(" "))}</p>`);
}

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Distru CSV Importer: start here</title><style>
@page { size: Letter; margin: 0.55in 0.6in; }
body { font: 10.5px/1.45 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1d1f1c; margin: 0; }
h1 { font-size: 20px; margin: 0 0 8px; padding-bottom: 6px; border-bottom: 3px solid #26d07c; }
h2 { font-size: 13px; margin: 14px 0 5px; }
p { margin: 0 0 6px; } ol, ul { margin: 0 0 6px; padding-left: 18px; } li { margin: 0 0 2px; }
a { color: #0d7a45; } code, .path, pre { font-family: Menlo, Consolas, monospace; font-size: 9.5px; }
code, .path { background: #f1f2ee; padding: 0 3px; border-radius: 3px; }
pre { background: #121512; color: #e9f7ef; padding: 8px 10px; border-radius: 6px; margin: 0 0 6px; }
table { border-collapse: collapse; width: 100%; margin: 0 0 6px; }
th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid #e3e5df; vertical-align: top; } th { background: #f6f7f3; }
</style></head><body>${html.join("\n")}</body></html>`;

const dir = mkdtempSync(join(tmpdir(), "start-here-"));
writeFileSync(join(dir, "index.html"), page);
execFileSync(chrome, ["--headless", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${out}`, `file://${join(dir, "index.html")}`], { stdio: "ignore" });
console.log(`wrote ${out}`);
