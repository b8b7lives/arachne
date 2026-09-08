import { withBrowser } from "./cdp.js";

const url = process.argv[2] || process.env.ARACHNE_URL || "http://127.0.0.1:5173/";
const READY = `new Promise((res) => {
  const t0 = Date.now();
  const tick = () => {
    const s = document.getElementById("status")?.textContent ?? "";
    if (/^ready/.test(s) && document.querySelector(".palette-row")) return res(s);
    if (Date.now() - t0 > 12000) return res("TIMEOUT: " + s);
    setTimeout(tick, 200);
  };
  tick();
})`;

const INVENTORY = `(() => {
  const SEL = "h2, .sub-head, .note, p, li, summary, label, .field-name, button, legend, dt, dd, th, .flag-word, .flag-gloss, .chip-note, .chip-adjust";
  const visible = (el) =>
    el.getClientRects().length > 0 &&
    !(el.closest("details:not([open])") && !el.closest("summary"));
  const kindOf = (el) => {
    const c = el.classList;
    if (el.tagName === "H2") return "title";
    if (c.contains("sub-head")) return "subhead";
    if (c.contains("note")) return "note";
    if (c.contains("field-name") || el.tagName === "LABEL" || el.tagName === "LEGEND" || el.tagName === "DT" || el.tagName === "TH") return "label";
    if (el.tagName === "P") return "para";
    if (el.tagName === "LI") return "bullet";
    if (el.tagName === "SUMMARY") return "fold";
    if (el.tagName === "BUTTON") return "button";
    if (el.tagName === "DD") return "value";
    return "text";
  };
  const out = [];
  const hidden = [];
  for (const section of document.querySelectorAll("section")) {
    const h2 = section.querySelector("h2");
    const sec = (h2 ? h2.childNodes[0]?.textContent : section.id || "?").trim();
    const cands = [...section.querySelectorAll(SEL)];
    for (const el of cands) {
      const inner = [...el.querySelectorAll(SEL)];
      let own = el.innerText || el.textContent || "";
      if (!visible(el)) {
        const t = (el.textContent || "").replace(/\\s+/g, " ").trim();
        if (t && !inner.length) hidden.push({ sec, kind: kindOf(el), text: t });
        continue;
      }
      for (const d of inner) {
        const t = d.innerText || "";
        if (t) own = own.replace(t, " ");
      }
      own = own.replace(/\\s+/g, " ").trim();
      if (!own) continue;
      out.push({ sec, kind: kindOf(el), id: el.id || "", text: own, title: el.getAttribute("title") || "" });
    }
  }
  const seen = new Set();
  const titles = [...document.querySelectorAll("[title]")]
    .filter(visible)
    .filter((el) => !el.closest(".palette-row, .tile-strip, .materials"))
    .map((el) => ({ sec: el.closest("section")?.querySelector("h2")?.childNodes[0]?.textContent.trim() || "?", text: el.getAttribute("title") }))
    .filter((t) => t.text && !seen.has(t.text) && seen.add(t.text));
  return { out, hidden, titles };
})()`;

const words = (s) => (s ? s.trim().split(/\s+/).length : 0);
const fate = (r) => {
  const n = words(r.text);
  if (["title", "subhead", "button", "fold", "label", "value"].includes(r.kind)) return "keep";
  if (r.kind === "note" && r.id) return "keep (state)";
  if (r.kind === "bullet") return "faq";
  if (r.kind === "note") return n > 28 ? "faq" : n > 12 ? "tooltip" : "cut?";
  if (r.kind === "para") return n > 40 ? "trim" : "keep";
  return "?";
};
const cell = (s, max = 120) =>
  (s.length > max ? `${s.slice(0, max - 3)}...` : s).replace(/\|/g, "\\|");

await withBrowser({ width: 1400, height: 1000 }, async (s) => {
  await s.send("Page.navigate", { url });
  const st = await s.evaluate(READY);
  if (String(st).startsWith("TIMEOUT")) throw new Error(st);
  const { out, hidden, titles } = await s.evaluate(INVENTORY);
  const lines = [];
  lines.push("# Copy inventory, Arachne app page, 2026-09-06\n");
  lines.push(
    "Every visible text block on the live page in its default state (nothing loaded, all folds as shipped), grouped by section, with a proposed fate. Hover titles are listed at the end. Heuristic fates: bullets go to the FAQ, long notes go to the FAQ, mid notes become hover titles, short static notes are cut candidates, state notes (filled by the app) stay. Redline the fate column. Context: minecraft#81.\n",
  );
  const total = out.reduce((a, r) => a + words(r.text), 0);
  const noteWords = out
    .filter((r) => r.kind === "note" || r.kind === "bullet" || r.kind === "para")
    .reduce((a, r) => a + words(r.text), 0);
  const hiddenWords = hidden.reduce((a, r) => a + words(r.text), 0);
  const titleWords = titles.reduce((a, t) => a + words(t.text), 0);
  lines.push(
    `Visible: ${out.length} blocks, ${total} words, of which ${noteWords} are prose (notes, bullets, paragraphs). Hidden by default: ${hidden.length} blocks, ${hiddenWords} words. Hover titles: ${titles.length}, ${titleWords} words.\n`,
  );
  const secs = [...new Set(out.map((r) => r.sec))];
  lines.push("| section | blocks | words | prose words | notes | bullets |");
  lines.push("|---|---|---|---|---|---|");
  for (const sec of secs) {
    const rs = out.filter((r) => r.sec === sec);
    const prose = rs.filter((r) => ["note", "bullet", "para"].includes(r.kind));
    lines.push(
      `| ${sec} | ${rs.length} | ${rs.reduce((a, r) => a + words(r.text), 0)} | ${prose.reduce((a, r) => a + words(r.text), 0)} | ${rs.filter((r) => r.kind === "note").length} | ${rs.filter((r) => r.kind === "bullet").length} |`,
    );
  }
  lines.push("");
  for (const sec of secs) {
    lines.push(`## ${sec}\n`);
    lines.push("| kind | words | text | fate |");
    lines.push("|---|---|---|---|");
    for (const r of out.filter((r) => r.sec === sec)) {
      lines.push(`| ${r.kind} | ${words(r.text)} | ${cell(r.text)} | ${fate(r)} |`);
    }
    lines.push("");
  }
  lines.push("## Hidden by default\n");
  lines.push("| section | kind | words | text |");
  lines.push("|---|---|---|---|");
  for (const r of hidden)
    lines.push(`| ${r.sec} | ${r.kind} | ${words(r.text)} | ${cell(r.text)} |`);
  lines.push("");
  lines.push("## Hover titles (deduplicated, palette tiles excluded)\n");
  lines.push("| section | words | text |");
  lines.push("|---|---|---|");
  for (const t of titles) lines.push(`| ${t.sec} | ${words(t.text)} | ${cell(t.text, 140)} |`);
  lines.push("");
  process.stdout.write(lines.join("\n"));
});
