import { mkdirSync, writeFileSync } from "node:fs";
import { esc, fail, OG_ALT, OG_IMAGE, readJson, SITE, THEME_COLOR } from "./lib.js";

const BLOCKS = process.env.PAGES_BLOCKS || "../data/blocks-26.2.json";
const VERSIONS = process.env.PAGES_VERSIONS || "../data/versions.json";
const ATLAS = process.env.PAGES_ATLAS || "public/atlas.json";
const CHANGELOG = process.env.PAGES_CHANGELOG || "public/changelog.json";
const VOCAB = process.env.PAGES_VOCAB || "src/vocab.json";
const OUT = process.env.PAGES_OUT || ".";
const TILE_PX = 32;

const hex = (rgb) => `#${rgb.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const vocab = readJson(VOCAB);
const FLAG_WORDS = [
  "support_mandatory",
  "gravity",
  "unstable",
  "constrained",
  "flammable",
  "fluid",
].map((k) => {
  if (!vocab[k]) fail(`vocab.json has no entry for ${k}`);
  return [k, vocab[k].word, vocab[k].short];
});

const TIER_WORD = {
  stone: "stone or better",
  iron: "iron or better",
  diamond: "diamond or better",
};

function recoverWord(b) {
  if (b.recoverability === "never" || b.recoverability === "no_table")
    return ["never", "no way to get this block back once broken"];
  if (b.gate === "silk") return ["silk touch", vocab.silk_gated.short];
  if (b.gate === "silk_or_shears")
    return ["shears or silk touch", "either tool recovers the block itself"];
  if (b.gate === "shears") return ["shears", "only shears recover the block itself"];
  return ["any tool", "drops itself however you break it"];
}

function toolCell(b) {
  const name = b.tool === "none" ? "hand" : b.tool;
  const parts = [];
  if (b.min_tier && b.min_tier !== "none") parts.push(TIER_WORD[b.min_tier] || b.min_tier);
  if (b.requires_tool) parts.push("required");
  else if (b.tool !== "none") parts.push("fastest");
  return `${esc(name)}${parts.length ? `<span class="dim"> ${esc(parts.join(", "))}</span>` : ""}`;
}

function shell({ path, title, description, body, ld, extraHead = "" }) {
  const url = SITE + path;
  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `  <head>`,
    `    <meta charset="UTF-8" />`,
    `    <meta name="viewport" content="width=device-width, initial-scale=1.0" />`,
    `    <title>${esc(title)}</title>`,
    `    <meta name="description" content="${esc(description)}" />`,
    `    <link rel="canonical" href="${url}" />`,
    `    <meta property="og:type" content="website" />`,
    `    <meta property="og:url" content="${url}" />`,
    `    <meta property="og:title" content="${esc(title)}" />`,
    `    <meta property="og:description" content="${esc(description)}" />`,
    `    <meta property="og:image" content="${OG_IMAGE}" />`,
    `    <meta property="og:image:width" content="1200" />`,
    `    <meta property="og:image:height" content="630" />`,
    `    <meta property="og:image:alt" content="${esc(OG_ALT)}" />`,
    `    <meta property="og:site_name" content="b8b7.live" />`,
    `    <meta name="twitter:card" content="summary_large_image" />`,
    `    <script type="application/ld+json">${JSON.stringify(ld)}</script>`,
    `    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />`,
    `    <link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32" />`,
    `    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />`,
    `    <link rel="alternate" type="application/atom+xml" title="Arachne release notes" href="${SITE}feed.xml" />`,
    `    <meta name="theme-color" content="${THEME_COLOR}" />`,
    `    <link rel="stylesheet" href="/src/site.css" />`,
    extraHead,
    `  </head>`,
    `  <body class="page">`,
    `    <header class="site-head">`,
    `      <a class="site-name" href="../">Arachne</a>`,
    `      <span class="site-tag">Minecraft map art maker</span>`,
    `      <nav class="site-nav"><a href="../colors/">map colors</a><a href="../changelog/">release notes</a></nav>`,
    `    </header>`,
    `    <main class="page-main">`,
    body,
    `    </main>`,
    `    <footer class="site-foot">`,
    `      <p><a href="../">Open Arachne</a> · <a href="${SITE}feed.xml">release notes feed</a> · <a href="https://b8b7.live/">b8b7.live</a></p>`,
    `      <p><a href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noopener noreferrer">GPL-3.0</a> · questions and bug reports go to <a href="mailto:arachne@b8b7.live">arachne@b8b7.live</a></p>`,
    `      <p class="legal">Minecraft block textures and block data are the property of Mojang. This project is independent and has no connection to Mojang or Microsoft.</p>`,
    `    </footer>`,
    `  </body>`,
    `</html>`,
    ``,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function breadcrumb(name, path) {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: name,
    url: SITE + path,
    isPartOf: { "@type": "WebApplication", name: "Arachne", url: SITE },
    breadcrumb: {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Arachne", item: SITE },
        { "@type": "ListItem", position: 2, name: name, item: SITE + path },
      ],
    },
  };
}

function colorsPage(data, versions, atlas) {
  const colors = [...data.colors].sort((a, b) => a.id - b.id);
  const blocks = data.blocks;
  const latest = Object.entries(versions.data_versions).find(
    ([, dv]) => dv === data.meta.data_version,
  )?.[0];
  if (!latest) fail("blocks data_version not found in versions.json");
  const floor = versions.meta.floor;
  const byColor = new Map();
  blocks.forEach((b, i) => {
    if (!byColor.has(b.color_id)) byColor.set(b.color_id, []);
    byColor.get(b.color_id).push({ ...b, tile: i });
  });
  for (const c of colors) if (!byColor.has(c.id)) fail(`color ${c.id} has no blocks`);
  const ids = new Set();
  const anchors = colors.map((c) => {
    const a = slug(c.name);
    if (ids.has(a)) fail(`duplicate anchor ${a}`);
    ids.add(a);
    return a;
  });

  const title = `Minecraft map art colors and blocks · Arachne`;
  const description = `All ${colors.length} Minecraft map colors with their three staircase shades and every block that renders each one, ${floor} to ${latest}, read from the game itself.`;

  const toc = colors
    .map(
      (c, i) =>
        `<a class="chip sw-${c.id}-n" href="#${anchors[i]}" title="${esc(c.name)}" aria-label="${esc(c.name)}"></a>`,
    )
    .join("");

  const sections = colors.map((c, i) => {
    const rows = byColor.get(c.id).map((b) => {
      const props = Object.entries(b.properties || {})
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      const [recover, recoverTitle] = recoverWord(b);
      const flags = FLAG_WORDS.filter(([k]) => b[k])
        .map(([, w, t]) => `<span title="${esc(t)}">${esc(w)}</span>`)
        .join("");
      return [
        `<tr>`,
        `<td><span class="tile t-${b.tile}" role="img" aria-label="${esc(b.display_name)}"></span></td>`,
        `<td>${esc(b.display_name)}<br /><span class="id">${esc(b.block_id)}${props ? `[${esc(props)}]` : ""}</span></td>`,
        `<td>${toolCell(b)}</td>`,
        `<td title="${esc(recoverTitle)}">${esc(recover)}</td>`,
        `<td class="num">${b.hardness}</td>`,
        `<td class="flags">${flags}</td>`,
        `<td class="num">${esc(b.since)}</td>`,
        `</tr>`,
      ].join("");
    });
    const tones = [
      ["dark", c.tones.dark],
      ["normal", c.tones.normal],
      ["light", c.tones.light],
    ]
      .map(
        ([t, rgb]) =>
          `<div class="tone"><div class="sw sw-${c.id}-${t[0]}"></div><span class="lab">${t} ${hex(rgb)}</span></div>`,
      )
      .join("");
    return [
      `<section class="color" id="${anchors[i]}">`,
      `<h2><span class="num">${c.id}</span> ${esc(c.name)} <span class="const">${esc(c.constant)}</span> <span class="since">since ${esc(c.since)}</span></h2>`,
      `<div class="tones">${tones}</div>`,
      `<table class="blocks"><thead><tr><th></th><th>block</th><th>tool</th><th>getting it back</th><th class="num">hardness</th><th>notes</th><th class="num">since</th></tr></thead><tbody>`,
      rows.join(""),
      `</tbody></table>`,
      `</section>`,
    ].join("\n");
  });

  const body = [
    `<h1>Minecraft map art colors and blocks</h1>`,
    `<p class="lede">A filled map paints every block as one of ${colors.length} colors. Each one below is listed with its three buildable shades and every block that renders it, from Minecraft ${esc(floor)} to ${esc(latest)}. The block list, colors and flags are read from the game's own files. The color names are Arachne's, since the game only numbers them.</p>`,
    `<p>On a staircased map a block's shade depends on its height against the block directly north of it. Higher reads light, level reads normal, and lower reads dark. A flat map only ever shows the normal shade. That is why the first row of a map art build needs a reference row along its north edge, or the top row renders a shade too bright. A fourth, darker shade exists in the game's color table, but no arrangement of blocks produces it. The game uses it only on explorer map previews, so for a build it appears only in map data written directly.</p>`,
    `<p>Every block listed under a color renders the exact same pixel. The choice between them is about what you mine and haul, which is what <a href="../">Arachne</a> prices for your tools. Blocks that need a special ground or a fluid to exist, and blocks that make no sense as map art, are left out on purpose.</p>`,
    `<nav class="toc" aria-label="colors">${toc}</nav>`,
    sections.join("\n"),
  ].join("\n");

  const css = [
    `.tile{background-image:url("/atlas.webp?v=${atlas.hash}");background-size:${atlas.cols * TILE_PX}px auto}`,
    ...blocks.map(
      (_, i) =>
        `.t-${i}{background-position:-${(i % atlas.cols) * TILE_PX}px -${Math.floor(i / atlas.cols) * TILE_PX}px}`,
    ),
    ...colors.flatMap((c) => [
      `.sw-${c.id}-d{background:${hex(c.tones.dark)}}`,
      `.sw-${c.id}-n{background:${hex(c.tones.normal)}}`,
      `.sw-${c.id}-l{background:${hex(c.tones.light)}}`,
    ]),
    ``,
  ].join("\n");

  const html = shell({
    path: "colors/",
    title,
    description,
    body,
    ld: breadcrumb("Minecraft map art colors and blocks", "colors/"),
    extraHead: `    <link rel="stylesheet" href="/colors/colors.css" />`,
  });
  return { html, css, colors: colors.length, blocks: blocks.length };
}

function changelogPage(changelog) {
  const builds = changelog.builds;
  if (!Array.isArray(builds) || builds.length === 0) fail("changelog has no builds");
  const sorted = [...builds].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const title = `Arachne release notes`;
  const description = `What changed in each published build of Arachne, the Minecraft map art maker, newest first.`;
  const entries = sorted.map((b) =>
    [
      `<article class="release" id="${esc(b.id)}">`,
      `<h2><a href="#${esc(b.id)}">${esc(b.line)}</a></h2>`,
      `<p class="date"><time datetime="${esc(b.date)}">${esc(b.date)}</time></p>`,
      `<ul>${b.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`,
      `</article>`,
    ].join("\n"),
  );
  const body = [
    `<h1>Arachne release notes</h1>`,
    `<p class="lede">Every published build, newest first. The same notes go out on the <a href="${SITE}feed.xml">Atom feed</a> and in the Discord announcements channel.</p>`,
    entries.join("\n"),
  ].join("\n");
  const html = shell({
    path: "changelog/",
    title,
    description,
    body,
    ld: breadcrumb("Arachne release notes", "changelog/"),
  });
  return { html, entries: sorted.length };
}

function check(name, html) {
  if (html.includes("<!--")) fail(`${name}: comment in served output`);
  if (/\sstyle="/.test(html)) fail(`${name}: inline style in served output`);
  if (/<script(?![^>]*application\/ld\+json)/.test(html))
    fail(`${name}: inline script in served output`);
  if (/[–—]/.test(html)) fail(`${name}: en or em dash in visitor copy`);
}

const data = readJson(BLOCKS);
const versions = readJson(VERSIONS);
const atlas = readJson(ATLAS);
const changelog = readJson(CHANGELOG);
if (atlas.count !== data.blocks.length)
  fail(`atlas has ${atlas.count} tiles, blocks has ${data.blocks.length}`);

const colors = colorsPage(data, versions, atlas);
const notes = changelogPage(changelog);
check("colors", colors.html);
check("changelog", notes.html);

mkdirSync(`${OUT}/colors`, { recursive: true });
mkdirSync(`${OUT}/changelog`, { recursive: true });
writeFileSync(`${OUT}/colors/index.html`, colors.html);
writeFileSync(`${OUT}/colors/colors.css`, colors.css);
writeFileSync(`${OUT}/changelog/index.html`, notes.html);
console.log(
  `pages.js: colors (${colors.colors} colors, ${colors.blocks} blocks), changelog (${notes.entries} entries)`,
);
