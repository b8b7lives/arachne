import { readFileSync, writeFileSync } from "fs";

const CHANGELOG = process.env.FEED_CHANGELOG || "public/changelog.json";
const OUT = process.env.FEED_OUT || "public/feed.xml";
const SITE = "https://b8b7.live/arachne/";
const SELF = "https://b8b7.live/arachne/feed.xml";

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const fail = (msg) => {
  console.error(`feed.js: ${msg}`);
  process.exit(1);
};

let data;
try {
  data = JSON.parse(readFileSync(CHANGELOG, "utf8"));
} catch (e) {
  fail(`cannot read ${CHANGELOG}: ${e.message}`);
}

const builds = data && data.builds;
if (!Array.isArray(builds) || builds.length === 0)
  fail("changelog has no builds array or it is empty");

const seen = new Set();
for (const b of builds) {
  if (typeof b.id !== "string" || !/^[a-z0-9-]+$/.test(b.id))
    fail(`build id missing or not a slug: ${JSON.stringify(b.id)}`);
  if (seen.has(b.id)) fail(`duplicate build id: ${b.id}`);
  seen.add(b.id);
  if (typeof b.date !== "string" || Number.isNaN(Date.parse(b.date)) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(b.date))
    fail(`build ${b.id}: date missing or not YYYY-MM-DD`);
  if (typeof b.line !== "string" || b.line.trim() === "")
    fail(`build ${b.id}: line missing or empty`);
  if (!Array.isArray(b.notes) || b.notes.length === 0 ||
      b.notes.some((n) => typeof n !== "string" || n.trim() === ""))
    fail(`build ${b.id}: notes missing, empty, or non-string`);
}

const newest = builds
  .map((b) => b.date)
  .sort()
  .at(-1);

const entries = builds
  .map((b) => {
    const html =
      `<p>${esc(b.line)}</p><ul>` +
      b.notes.map((n) => `<li>${esc(n)}</li>`).join("") +
      `</ul>`;
    return [
      `  <entry>`,
      `    <title>${esc(b.line)}</title>`,
      `    <id>tag:b8b7.live,2026:arachne:${esc(b.id)}</id>`,
      `    <link href="${SITE}"/>`,
      `    <updated>${b.date}T00:00:00Z</updated>`,
      `    <content type="html">${esc(html)}</content>`,
      `  </entry>`,
    ].join("\n");
  })
  .join("\n");

const xml = [
  `<?xml version="1.0" encoding="utf-8"?>`,
  `<feed xmlns="http://www.w3.org/2005/Atom">`,
  `  <title>Arachne release notes</title>`,
  `  <subtitle>What changed in each published build of Arachne, the Minecraft map art generator.</subtitle>`,
  `  <id>${SITE}</id>`,
  `  <link href="${SITE}"/>`,
  `  <link rel="self" href="${SELF}"/>`,
  `  <updated>${newest}T00:00:00Z</updated>`,
  `  <author><name>b8b7</name></author>`,
  entries,
  `</feed>`,
  ``,
].join("\n");

writeFileSync(OUT, xml);
console.log(`feed.js: wrote ${OUT} (${builds.length} entries, newest ${newest})`);
