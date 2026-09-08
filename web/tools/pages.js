import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { esc, fail, OG_ALT, OG_IMAGE, readJson, SITE, THEME_COLOR } from "./lib.js";

const BLOCKS = process.env.PAGES_BLOCKS || "../data/blocks-26.2.json";
const VERSIONS = process.env.PAGES_VERSIONS || "../data/versions.json";
const ATLAS = process.env.PAGES_ATLAS || "public/atlas.json";
const CHANGELOG = process.env.PAGES_CHANGELOG || "public/changelog.json";
const VOCAB = process.env.PAGES_VOCAB || "src/vocab.json";
const FAQ = process.env.PAGES_FAQ || "src/faq.json";
const FONTS = process.env.PAGES_FONTS || "../data/fonts.json";
const FONT_GROUPS = process.env.PAGES_FONT_GROUPS || "src/font-groups.json";
const OUT = process.env.PAGES_OUT || ".";
const TILE_PX = 32;

const hex = (rgb) => `#${rgb.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const vocab = readJson(VOCAB);
const FLAG_WORDS = ["support_mandatory", "gravity", "unstable", "constrained", "flammable"].map(
  (k) => {
    if (!vocab[k]) fail(`vocab.json has no entry for ${k}`);
    return [k, vocab[k].word, vocab[k].short];
  },
);

const LINK_PREFIXES = [
  "https://b8b7.live/",
  "https://github.com/b8b7lives",
  "https://modrinth.com/",
  "https://ko-fi.com/b8b7live",
  "https://rebane2001.com/mapartcraft/",
  "https://enginehub.org/worldedit",
  "https://github.com/google/fonts/",
  "mailto:arachne@b8b7.live",
];

function linkOk(href) {
  if (/^(\.\.\/|#)/.test(href)) return true;
  return LINK_PREFIXES.some((p) => href.startsWith(p));
}

function buildStamp(dataVersion) {
  let id = "unknown";
  try {
    const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim() !== "";
    id = dirty ? `${sha}+local` : sha;
  } catch {}
  return `${id} · ${new Date().toISOString().slice(0, 10)} · data ${dataVersion}`;
}

const MARK = /\{\{build id\}\}|\[([^\]]+)\]\(([^)]+)\)|\{([^}]+)\}/g;

function plain(s) {
  return s.replace(MARK, (m, text, _href, ctl) =>
    m === "{{build id}}" ? "build id" : (text ?? ctl),
  );
}

function inline(s, stamp) {
  const out = [];
  let last = 0;
  for (const m of s.matchAll(MARK)) {
    out.push(esc(s.slice(last, m.index)));
    if (m[0] === "{{build id}}") {
      out.push(
        `<button type="button" class="copy-build" data-copy="${esc(stamp)}" title="click to copy">${esc(stamp.split(" · ")[0])}</button>`,
      );
    } else if (m[1] !== undefined) {
      if (!linkOk(m[2])) fail(`faq: link not allowed: ${m[2]}`);
      const blank = /^https?:/.test(m[2]) ? ` target="_blank" rel="noopener noreferrer"` : "";
      out.push(`<a href="${esc(m[2])}"${blank}>${esc(m[1])}</a>`);
    } else {
      out.push(`<span class="ctl">${esc(m[3])}</span>`);
    }
    last = m.index + m[0].length;
  }
  out.push(esc(s.slice(last)));
  return out.join("");
}

function copyCheck(where, text) {
  const t = plain(text);
  if (/[:;–—]| - /.test(t)) fail(`${where}: colon, semicolon or dash in copy: ${t.slice(0, 60)}`);
}

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
    `      <nav class="site-nav"><a href="../faq/">FAQ</a><a href="../colors/">colors</a><a href="../fonts/">fonts</a><a href="../changelog/">release notes</a></nav>`,
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
  const blocks = data.blocks;
  const colors = data.colors
    .filter((c) => blocks.some((b) => b.color_id === c.id))
    .sort((a, b) => a.id - b.id);
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
  const ids = new Set();
  const anchors = colors.map((c) => {
    const a = slug(c.name);
    if (ids.has(a)) fail(`duplicate anchor ${a}`);
    ids.add(a);
    return a;
  });

  const title = `Minecraft map art colors and blocks · Arachne`;
  const description = `The ${colors.length} Minecraft map colors Arachne builds with, each with its three staircase shades and every block that renders it, ${floor} to ${latest}, read from the game itself.`;

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
    `<p class="lede">A filled map paints every block as one of a fixed set of map colors. The ${colors.length} Arachne builds with are listed below, each with its three buildable shades and every block that renders it, from Minecraft ${esc(floor)} to ${esc(latest)}. The block list, colors and flags are read from the game's own files. The color names are Arachne's, since the game only numbers them.</p>`,
    `<p>On a staircased map a block's shade depends on its height against the block directly north of it. Higher reads light, level reads normal, and lower reads dark. A flat map only ever shows the normal shade. That is why the first row of a map art build needs a reference row along its north edge, or the top row renders a shade too bright. A fourth, darker shade exists in the game's color table, but no arrangement of blocks produces it. The game uses it only on explorer map previews, so for a build it appears only in map data written directly.</p>`,
    `<p>Every block listed under a color renders the exact same pixel. The choice between them is about what you mine and haul, which is what <a href="../">Arachne</a> prices for your tools. Fluids, blocks that need a special ground to exist, and blocks that make no sense as map art are left out on purpose.</p>`,
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

function faqPage(faq, stamp) {
  const items = faq.items;
  if (!Array.isArray(items) || items.length === 0) fail("faq has no items");
  const ids = new Set();
  for (const it of items) {
    if (!/^[a-z][a-z0-9-]*$/.test(it.id || "")) fail(`faq: bad id ${JSON.stringify(it.id)}`);
    if (ids.has(it.id)) fail(`faq: duplicate id ${it.id}`);
    ids.add(it.id);
    if (typeof it.q !== "string" || !/\?$/.test(it.q))
      fail(`faq ${it.id}: the question must end with a question mark`);
    if (!Array.isArray(it.a) || it.a.length === 0) fail(`faq ${it.id}: no answer`);
    copyCheck(`faq ${it.id} question`, it.q);
    for (const p of it.a) {
      if (typeof p !== "string" || !/\.$/.test(plain(p)))
        fail(`faq ${it.id}: every paragraph ends with a period`);
      copyCheck(`faq ${it.id}`, p);
    }
  }
  for (const it of items) {
    for (const p of it.a) {
      for (const m of p.matchAll(/\]\(#([a-z0-9-]+)\)/g)) {
        if (!ids.has(m[1])) fail(`faq ${it.id}: link to unknown anchor ${m[1]}`);
      }
    }
  }
  const title = `Minecraft map art questions and answers · Arachne`;
  const description = `Plain answers to the questions people ask about Minecraft map art and about Arachne, from how a map shades its blocks to which file to download.`;
  const index = `<ol class="qlist">${items.map((it) => `<li><a href="#${it.id}">${esc(it.q)}</a></li>`).join("")}</ol>`;
  const sections = items.map((it) =>
    [
      `<section class="q" id="${it.id}">`,
      `<h2><a href="#${it.id}">${esc(it.q)}</a></h2>`,
      ...it.a.map((p) => `<p>${inline(p, stamp)}</p>`),
      `</section>`,
    ].join("\n"),
  );
  const body = [
    `<h1>Minecraft map art questions and answers</h1>`,
    `<p class="lede">What people ask before and after a first build.</p>`,
    index,
    sections.join("\n"),
  ].join("\n");
  const html = shell({
    path: "faq/",
    title,
    description,
    body,
    ld: breadcrumb("Minecraft map art questions and answers", "faq/"),
    extraHead: `    <script type="module" src="/src/faq.ts"></script>`,
  });
  return { html, questions: items.length };
}

function fontGroup(face, groups) {
  for (const key of groups.order) {
    const g = groups.groups[key];
    if (g.tags.length === 0) return key;
    for (const [tag, score] of Object.entries(face.tags || {})) {
      const hit = g.tags.some((t) => (t.endsWith("/") ? tag.startsWith(t) : tag === t));
      if (hit && score >= g.min) return key;
    }
  }
  return "display";
}

function fontsPage(manifest, groups) {
  const faces = manifest.faces;
  if (!Array.isArray(faces) || faces.length === 0) fail("fonts manifest has no faces");
  const commit = manifest.source.commit;
  if (!/^[0-9a-f]{40}$/.test(commit)) fail("fonts manifest has no pinned commit");
  const strips = manifest.strips;
  if (!strips?.names?.file || !strips?.samples?.file) fail("fonts manifest has no sprite strips");
  const byGroup = new Map(groups.order.map((k) => [k, []]));
  for (const f of faces) byGroup.get(fontGroup(f, groups)).push(f);
  const kb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;
  const fileNote = (f) => {
    const weights = f.files.map((x) =>
      x.weight === "variable" ? "variable weight" : x.weight === 700 ? "bold" : "regular",
    );
    const files = `${weights.join(", ")}, ${kb(f.files.reduce((a, x) => a + x.bytes, 0))}`;
    return f.hinted ? `${files}, hinted letters ${kb(f.hinted.bytes)}` : files;
  };
  const sections = [];
  for (const key of groups.order) {
    const list = byGroup.get(key);
    if (list.length === 0) continue;
    list.sort((a, b) => a.name.localeCompare(b.name));
    const rows = list.map((f) => {
      const src = `https://github.com/google/fonts/tree/${commit}/${f.dir}`;
      if (!linkOk(src)) fail(`fonts: link not allowed: ${src}`);
      const extra = [
        f.native ? `pixel face, ${f.native} px grid` : "",
        f.hidden ? "used for emoji, not listed in the picker" : "",
      ]
        .filter(Boolean)
        .join("; ");
      return [
        `<tr id="${esc(f.id)}">`,
        `<th scope="row"><a href="#${esc(f.id)}" class="face-name fn-${esc(f.id)}" aria-label="${esc(f.name)}"></a><span class="face-text">${esc(f.name)}</span>${extra ? `<span class="note">${esc(extra)}</span>` : ""}</th>`,
        `<td>${esc(f.designer)}</td>`,
        `<td><a href="../fonts/catalog/${esc(f.id)}/${esc(f.license_file)}">${esc(f.license)}</a></td>`,
        `<td>${esc(fileNote(f))}</td>`,
        `<td><a href="${src}" target="_blank" rel="noopener noreferrer">google/fonts</a></td>`,
        `</tr>`,
        `<tr class="sample"><td colspan="5"><span class="face-sample fs-${esc(f.id)}" role="img" aria-label="a sample line in ${esc(f.name)}"></span></td></tr>`,
      ].join("");
    });
    sections.push(
      [
        `<section class="font-group" id="group-${key}">`,
        `<h2><a href="#group-${key}">${esc(groups.groups[key].label)}</a> <span class="count">${list.length}</span></h2>`,
        `<table class="fonts"><thead><tr><th scope="col">family</th><th scope="col">designer</th><th scope="col">license</th><th scope="col">files</th><th scope="col">source</th></tr></thead>`,
        `<tbody>${rows.join("")}</tbody></table>`,
        `</section>`,
      ].join("\n"),
    );
  }
  const total = faces.reduce((a, f) => a + f.files.reduce((b, x) => b + x.bytes, 0), 0);
  const sheets = faces.filter((f) => f.hinted);
  if (sheets.length === 0 || !manifest.hinted?.freetype)
    fail("fonts manifest has no hinted sheets");
  const own = sheets.filter((f) => f.hinted.hinting === "own").length;
  const sheetBytes = sheets.reduce((a, f) => a + f.hinted.bytes, 0);
  const sizes = manifest.hinted.sizes;
  const hintedNote =
    `<p>Every family except the pixel faces also carries a sheet of letters drawn ahead of time by FreeType ${esc(manifest.hinted.freetype)} at ${sizes[0]} to ${sizes[sizes.length - 1]} blocks, for the hinted letter style. ` +
    `${own} families are fitted to the grid by their own hinting and ${sheets.length - own} by FreeType's algorithm, because they carry none. ` +
    `A sheet downloads only when the style is used, and together they are ${kb(sheetBytes)}.</p>`;
  const toc = groups.order
    .filter((k) => byGroup.get(k).length > 0)
    .map((k) => `<a href="#group-${k}">${esc(groups.groups[k].label)}</a>`)
    .join("");
  const title = `Fonts in Arachne · ${faces.length} free families for map art text`;
  const description = `Every font family Arachne ships for text on Minecraft maps, with its designer, its license, and where it came from. All of them are free and open source.`;
  const body = [
    `<h1>Fonts in Arachne</h1>`,
    `<p class="lede">${faces.length} families for the text tool, every one free and open source. Each family ships exactly as its designer published it, with the license file beside it, and a font only downloads when you pick it. Together they are ${kb(total)}.</p>`,
    `<p>Families come from the google/fonts repository at commit <code>${esc(commit.slice(0, 12))}</code>, the same place the licenses link to. The group names below are Arachne's; the underlying tags are the repository's own.</p>`,
    hintedNote,
    `<nav class="toc toc-fonts" aria-label="font groups">${toc}</nav>`,
    sections.join("\n"),
  ].join("\n");
  const rows = Math.max(...faces.map((f) => f.strip)) + 1;
  const sheet = (s) =>
    `display:block;width:100%;max-width:${s.w}px;aspect-ratio:${s.w} / ${s.h};background:url("/fonts/catalog/${s.file}") no-repeat;background-size:100% auto`;
  const rowPos = (f) => (rows > 1 ? `0 ${((f.strip / (rows - 1)) * 100).toFixed(4)}%` : "0 0");
  const css = [
    `.face-name{${sheet(strips.names)}}`,
    `.face-sample{${sheet(strips.samples)}}`,
    ...faces.map((f) => `.fn-${f.id},.fs-${f.id}{background-position:${rowPos(f)}}`),
    "",
  ].join("\n");
  const html = shell({
    path: "fonts/",
    title,
    description,
    body,
    ld: breadcrumb("Fonts in Arachne", "fonts/"),
    extraHead: `    <link rel="stylesheet" href="/fonts/fonts.css" />`,
  });
  return { html, css, families: faces.length, groups: sections.length };
}

function check(name, html) {
  if (html.includes("<!--")) fail(`${name}: comment in served output`);
  if (/\sstyle="/.test(html)) fail(`${name}: inline style in served output`);
  if (/<script(?![^>]*(application\/ld\+json|\ssrc="))/.test(html))
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
const faq = faqPage(readJson(FAQ), buildStamp(data.meta.data_version));
const fonts = fontsPage(readJson(FONTS), readJson(FONT_GROUPS));
check("colors", colors.html);
check("changelog", notes.html);
check("faq", faq.html);
check("fonts", fonts.html);

mkdirSync(`${OUT}/colors`, { recursive: true });
mkdirSync(`${OUT}/changelog`, { recursive: true });
mkdirSync(`${OUT}/faq`, { recursive: true });
mkdirSync(`${OUT}/fonts`, { recursive: true });
writeFileSync(`${OUT}/colors/index.html`, colors.html);
writeFileSync(`${OUT}/colors/colors.css`, colors.css);
writeFileSync(`${OUT}/changelog/index.html`, notes.html);
writeFileSync(`${OUT}/faq/index.html`, faq.html);
writeFileSync(`${OUT}/fonts/index.html`, fonts.html);
writeFileSync(`${OUT}/fonts/fonts.css`, fonts.css);
console.log(
  `pages.js: colors (${colors.colors} colors, ${colors.blocks} blocks), changelog (${notes.entries} entries), faq (${faq.questions} questions), fonts (${fonts.families} families, ${fonts.groups} groups)`,
);
