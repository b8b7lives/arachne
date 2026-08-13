import { withBrowser } from "./cdp.js";

const url = process.argv[2] || process.env.ARACHNE_URL || "http://127.0.0.1:5173/";
const READY_MS = 9000;

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures++;
}

const WAIT_READY = `new Promise((res) => {
  const t0 = Date.now();
  const tick = () => {
    const s = document.getElementById("status")?.textContent ?? "";
    if (/^ready/.test(s) && document.querySelector(".palette-row")) return res(s);
    if (Date.now() - t0 > ${READY_MS}) return res("TIMEOUT: " + s);
    setTimeout(tick, 200);
  };
  tick();
})`;

const WORKSPACE = `JSON.parse(localStorage.getItem("arachne.workspace") || "null")`;
const SETTLE = `new Promise((r) => setTimeout(r, 900))`;

await withBrowser({ width: 1400, height: 1000 }, async (s) => {
  const dialogs = [];
  let promptText = "";
  s.on("Page.javascriptDialogOpening", async (p) => {
    dialogs.push(p.message);
    await s.send("Page.handleJavaScriptDialog", { accept: true, promptText });
  });

  const goto = async () => {
    await s.send("Page.navigate", { url });
    const st = await s.evaluate(WAIT_READY);
    if (String(st).startsWith("TIMEOUT")) throw new Error(`app never became ready: ${st}`);
    return st;
  };

  await goto();
  await s.evaluate(`(() => {
    const set = (id, v, prop = "value") => {
      const el = document.getElementById(id);
      el[prop] = v;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    set("haste", "3");
    set("dither", "atkinson");
    const nick = document.querySelector("input.nick");
    nick.value = "the grinder";
    nick.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelectorAll(".palette-row")[0].querySelector(".none-tile").click();
    const strip = document.querySelectorAll(".palette-row")[1]
      .querySelectorAll(".tile:not(.none-tile)");
    strip[2].click();
    window.__pickedTitle = strip[2].title.split("\\n")[0];
  })()`);
  await s.evaluate(SETTLE);

  const ws1 = await s.evaluate(WORKSPACE);
  check("workspace written", ws1 !== null);
  check("enabled colors persisted", ws1.enabled.length === 59, `${ws1.enabled.length} of 61`);
  check("block pick persisted by identity", Object.values(ws1.picks).length === 1
    && /^[a-z_]+(\[.+\])?$/.test(Object.values(ws1.picks)[0]), JSON.stringify(ws1.picks));
  check("deliberate pick recorded", ws1.deliberate.length === 1, JSON.stringify(ws1.deliberate));
  check("tool nickname persisted", ws1.tools[0].nick === "the grinder");
  check("form fields persisted", ws1.fields.haste === "3" && ws1.fields.dither === "atkinson");

  const nagged = await s.evaluate(`!!document.querySelector(".drift-banner")`);
  check("no nag for a deliberate pick", nagged === false);

  promptText = "test palette";
  await s.evaluate(`document.getElementById("palette-preset-save").click()`);
  await s.evaluate(SETTLE);
  const presets = await s.evaluate(
    `JSON.parse(localStorage.getItem("arachne.presets.palette") || "[]")`);
  check("palette preset saved", presets.length === 1 && presets[0].name === "test palette",
    JSON.stringify(presets.map((p) => p.name)));
  check("preset carries the palette", presets[0]?.enabled?.length === 59
    && Object.keys(presets[0]?.picks ?? {}).length === 1);
  const selName = await s.evaluate(
    `document.getElementById("palette-preset").selectedOptions[0].textContent`);
  check("select shows the saved preset", selName === "test palette", selName);

  const status = await goto();
  check("status reports the restore", /saved palette restored/.test(status), status);
  const after = await s.evaluate(`(() => {
    const rows = document.querySelectorAll(".palette-row");
    const sel = rows[1].querySelector(".tile.selected:not(.none-tile)");
    return {
      offRows: document.querySelectorAll(".palette-row.off").length,
      meta: document.getElementById("color-meta").textContent,
      picked: sel ? sel.title.split("\\n")[0] : null,
      haste: document.getElementById("haste").value,
      dither: document.getElementById("dither").value,
      nick: document.querySelector("input.nick").value,
      preset: document.getElementById("palette-preset").selectedOptions[0].textContent,
      banner: !!document.querySelector(".drift-banner"),
    };
  })()`);
  check("dropped color still dropped", after.offRows === 2 && after.meta === "59 of 61 colors, 2 turned off",
    after.meta);
  check("block pick restored", after.picked === (await s.evaluate(`window.__pickedTitle ?? null`))
    || after.picked !== null, after.picked);
  check("loadout + filters restored",
    after.haste === "3" && after.dither === "atkinson" && after.nick === "the grinder",
    `haste=${after.haste} dither=${after.dither} nick=${after.nick}`);
  check("preset still recognized as saved", after.preset === "test palette", after.preset);
  check("still no nag after reload", after.banner === false);

  await s.evaluate(`(() => {
    document.querySelectorAll(".palette-row").forEach((row, i) => {
      if (i >= 15) return;
      const t = row.querySelector(".tile:not(.none-tile)");
      if (t) t.click();
    });
  })()`);
  await s.evaluate(SETTLE);
  const beforePicks = await s.evaluate(`Object.keys((${WORKSPACE}).picks).length`);

  await s.evaluate(`(() => {
    document.querySelectorAll(".tool-item").forEach((item) => {
      const fire = (el, v, prop = "value") => {
        if (!el) return;
        el[prop] = v;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      fire(item.querySelector(".tool-tier"), "wood");
      fire(item.querySelector(".tool-eff"), "0");
      const silk = item.querySelector(".tool-silk");
      if (silk && silk.checked) fire(silk, false, "checked");
    });
  })()`);
  await s.evaluate(`new Promise((r) => setTimeout(r, 2500))`);

  const drift = await s.evaluate(`(() => {
    const b = document.querySelector(".drift-banner");
    if (!b) return null;
    const text = b.querySelector("span").textContent.trim();
    return { text, count: Number(text.match(/^(\\d+)/)?.[1] ?? 0) };
  })()`);
  check("stale picks are offered, not applied", drift !== null && /aren't the cheapest with this loadout/.test(drift.text),
    drift ? drift.text : "no banner");
  const keptPicks = await s.evaluate(`Object.keys((${WORKSPACE}).picks).length`);
  check("picks survived the loadout change", keptPicks === beforePicks,
    `${keptPicks} of ${beforePicks}`);

  const compare = await s.evaluate(`(() => {
    const btns = [...document.querySelectorAll(".drift-banner button")];
    btns.find((b) => b.textContent === "compare").click();
    const rows = [...document.querySelectorAll(".drift-table tbody tr")];
    const first = rows[0];
    return {
      rows: rows.length,
      headers: [...document.querySelectorAll(".drift-table thead th")].map((t) => t.textContent),
      yours: first.children[1].textContent.trim(),
      cheapest: first.children[2].textContent.trim(),
      saves: first.children[3].textContent.trim(),
      total: first.children[4].textContent.trim(),
      marked: document.querySelectorAll(".chip-drift").length,
    };
  })()`);
  check("the offer opens a comparison, one row per drifted pick",
    compare.rows === drift.count, `${compare.rows} rows vs ${drift.count} named`);
  check("comparison names both blocks with their costs",
    /·/.test(compare.yours) && /·/.test(compare.cheapest),
    `${compare.yours} | ${compare.cheapest}`);
  check("comparison quantifies the saving",
    /[0-9]/.test(compare.saves) || compare.saves === "makes it recoverable", compare.saves);
  check("the palette marks the same picks in place", compare.marked >= compare.rows,
    `${compare.marked} markers`);

  await s.evaluate(`(() => {
    const b = [...document.querySelectorAll(".drift-banner button")];
    b.find((x) => x.textContent.startsWith("use the cheapest")).click();
  })()`);
  await s.evaluate(SETTLE);
  const adopted = await s.evaluate(`({
    banner: !!document.querySelector(".drift-banner"),
    picks: Object.keys((${WORKSPACE}).picks).length,
  })`);
  check("one-click adopt clears the offer", adopted.banner === false);
  check("adopt drops only the stale picks", adopted.picks < beforePicks && adopted.picks > 0,
    `${adopted.picks} left of ${beforePicks}`);

  promptText = "";
  await s.evaluate(`document.getElementById("reset-default").click()`);
  await s.evaluate(`new Promise((r) => setTimeout(r, 2000))`);
  const reset = await s.evaluate(`(() => ({
    meta: document.getElementById("color-meta").textContent,
    haste: document.getElementById("haste").value,
    nick: document.querySelector("input.nick").value,
    presets: JSON.parse(localStorage.getItem("arachne.presets.palette") || "[]").length,
  }))()`);
  check("reset restores defaults", reset.meta === "all 61 colors in play"
    && reset.haste === "0" && reset.nick === "", JSON.stringify(reset));
  check("reset keeps saved presets", reset.presets === 1);

  const mode = await s.evaluate(
    `window.documentPictureInPicture ? "document-pip" : "popup-window"`);
  console.log(`      pop-out path under test: ${mode}`
    + (mode === "popup-window" ? " (this origin is not a secure context)" : ""));

  await s.evaluate(`(async () => {
    const c = document.createElement("canvas");
    c.width = 64; c.height = 64;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 64, 64);
    grad.addColorStop(0, "#f00"); grad.addColorStop(1, "#00f");
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    const blob = await new Promise((r) => c.toBlob(r));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "test.png", { type: "image/png" }));
    document.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  })()`);
  await s.evaluate(`new Promise((r) => setTimeout(r, 3000))`);
  const painted = await s.evaluate(
    `document.getElementById("preview").toDataURL().length > 1000`);
  check("preview rendered before the move", painted === true);
  const before = await s.evaluate(`document.getElementById("preview").toDataURL()`);

  await s.evaluate(`document.getElementById("preview-popout").click()`, { userGesture: true });
  await s.evaluate(`new Promise((r) => setTimeout(r, 1200))`);

  const out = await s.evaluate(`(() => {
    const w = window.documentPictureInPicture?.window ?? window.open("", "arachne-preview");
    const doc = w?.document ?? null;
    const cv = doc?.getElementById("preview") ?? null;
    return {
      movedOut: !document.getElementById("preview-slot").querySelector("#preview-wrap"),
      inWindow: !!cv,
      away: document.getElementById("preview-away").hidden === false,
      pixels: cv ? cv.toDataURL() : null,
      pixelated: cv ? w.getComputedStyle(cv).imageRendering : null,
      width: cv ? cv.style.width : null,
    };
  })()`);
  check("preview left the page", out.movedOut === true);
  check("preview is in the pop-out window", out.inWindow === true);
  check("page shows it is away", out.away === true);
  check("canvas survived the document move", out.pixels === before,
    out.pixels === null ? "no canvas" : `${out.pixels?.length} vs ${before.length} bytes`);
  check("stylesheets were copied across", out.pixelated === "pixelated", String(out.pixelated));

  const popZoom = await s.evaluate(`(() => {
    const w = window.documentPictureInPicture?.window ?? window.open("", "arachne-preview");
    const cv = w.document.getElementById("preview");
    return {
      disabled: ["zoom-in", "zoom-out", "zoom-fit"]
        .every((id) => document.getElementById(id).disabled),
      shown: Math.round(cv.getBoundingClientRect().width),
      body: w.document.body.clientWidth,
    };
  })()`);
  check("the pop-out fits its own window", popZoom.shown <= popZoom.body,
    `${popZoom.shown} in ${popZoom.body}`);
  check("zoom is disabled while popped out, not dead", popZoom.disabled === true);

  await s.evaluate(`document.getElementById("preview-return").click()`);
  await s.evaluate(`new Promise((r) => setTimeout(r, 800))`);
  const back = await s.evaluate(`(() => {
    const cv = document.getElementById("preview-slot").querySelector("#preview");
    return {
      home: !!cv,
      painted: cv ? cv.toDataURL().length > 1000 : false,
      away: document.getElementById("preview-away").hidden,
      closed: (window.documentPictureInPicture?.window ?? null) === null,
    };
  })()`);
  check("bring it back returns the preview", back.home === true && back.away === true);
  check("canvas survived the trip home", back.painted === true);
  if (mode === "document-pip") check("pip window closed", back.closed === true);

  const setCrop = async (zoom, x, y) => {
    await s.evaluate(`(() => {
      const set = (id, v) => {
        const el = document.getElementById(id);
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const fit = document.getElementById("fit");
      fit.value = "manual";
      fit.dispatchEvent(new Event("change", { bubbles: true }));
      set("crop-zoom", "${zoom}"); set("crop-x", "${x}"); set("crop-y", "${y}");
    })()`);
    await s.evaluate(`new Promise((r) => setTimeout(r, 2500))`);
    return s.evaluate(`({
      shown: !document.getElementById("crop-controls").hidden,
      meta: document.getElementById("preview-meta").textContent,
      zoomField: document.getElementById("crop-zoom-num").value,
      pixels: document.getElementById("preview").toDataURL(),
    })`);
  };
  const topLeft = await setCrop(2, 0, 0);
  check("manual crop reveals its controls", topLeft.shown === true);
  check("manual crop reports the framing", /framing 32×32/.test(topLeft.meta), topLeft.meta);
  check("number field mirrors the slider", topLeft.zoomField === "2", topLeft.zoomField);
  const bottomRight = await setCrop(2, 100, 100);
  check("moving the crop window changes the output",
    bottomRight.pixels !== topLeft.pixels);

  const typedCrop = await s.evaluate(`(() => {
    const f = document.getElementById("crop-x-num");
    f.value = "137";                       // past the max, on commit
    f.dispatchEvent(new Event("input", { bubbles: true }));
    f.dispatchEvent(new Event("change", { bubbles: true }));
    return { field: f.value, slider: document.getElementById("crop-x").value };
  })()`);
  check("typing into the field drives the slider and clamps on commit",
    typedCrop.field === "100" && typedCrop.slider === "100", JSON.stringify(typedCrop));
  const wide = await setCrop(1, 50, 50);
  check("zooming out changes the output again", wide.pixels !== topLeft.pixels
    && /framing 64×64/.test(wide.meta), wide.meta);

  await s.evaluate(`(() => {
    window.__dl = [];
    const origCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { window.__blob = blob; return origCreate(blob); };
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { window.__dl.push({ name: this.download, blob: window.__blob }); return; }
      return origClick.apply(this, arguments);
    };
  })()`);
  await s.evaluate(`(() => {
    const set = (id, v, prop = "value") => {
      const el = document.getElementById(id);
      el[prop] = v;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const fit = document.getElementById("fit");
    fit.value = "cover"; fit.dispatchEvent(new Event("change", { bubbles: true }));
    set("maps-w", "2"); set("maps-h", "2");
    set("first-map-id", "7");
    set("split-export", true, "checked");
  })()`);
  await s.evaluate(`new Promise((r) => setTimeout(r, 4000))`);
  const size = await s.evaluate(`document.getElementById("preview").width`);
  check("2x2 build generated", size === 256, `${size}px wide`);

  await s.evaluate(`(() => { window.__dl = []; document.getElementById("export-download").click(); })()`);
  await s.evaluate(`new Promise((r) => setTimeout(r, 4000))`);
  const zipped = await s.evaluate(`(async () => {
    const d = window.__dl[0];
    if (!d) return { name: null };
    const b = new Uint8Array(await d.blob.arrayBuffer());
    const text = new TextDecoder("latin1").decode(b);
    return {
      name: d.name,
      magic: b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4,
      names: [...text.matchAll(/arachne_x\\d+_z\\d+_map_\\d+\\.nbt/g)].map((m) => m[0]),
      bytes: b.length,
      dosYear: 1980 + ((b[13] << 8 | b[12]) >> 9),
      status: document.getElementById("status").textContent,
    };
  })()`);
  check("split export downloads a zip", zipped.name === "arachne.zip" && zipped.magic === true,
    `${zipped.name} (${zipped.bytes} bytes)`);
  check("one entry per map, named by grid position and map id",
    JSON.stringify([...new Set(zipped.names)])
      === JSON.stringify(["arachne_x0_z0_map_7.nbt", "arachne_x1_z0_map_8.nbt",
        "arachne_x0_z1_map_9.nbt", "arachne_x1_z1_map_10.nbt"]),
    JSON.stringify([...new Set(zipped.names)]));
  check("split export reports what it made", /5 files in arachne\.zip/.test(zipped.status),
    zipped.status);
  check("zip entries carry today's date, not the 1980 DOS epoch",
    zipped.dosYear === new Date().getFullYear(), `stamped ${zipped.dosYear}`);

  await s.evaluate(`(() => {
    const el = document.getElementById("split-export");
    el.checked = false;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    const sheet = document.getElementById("sheet-on");
    sheet.checked = false;
    sheet.dispatchEvent(new Event("change", { bubbles: true }));
    window.__dl = [];
    document.getElementById("export-download").click();
  })()`);
  await s.evaluate(`new Promise((r) => setTimeout(r, 4000))`);
  const joined = await s.evaluate(`(async () => {
    const d = window.__dl[0];
    const b = d ? new Uint8Array(await d.blob.arrayBuffer()) : null;
    return { name: d?.name ?? null, gzip: b ? b[0] === 0x1f && b[1] === 0x8b : false };
  })()`);
  check("a lone artifact downloads bare, not zipped",
    joined.name === "arachne.nbt" && joined.gzip === true, JSON.stringify(joined));

  const mapdatOff = await s.evaluate(`(() => ({
    note: document.getElementById("mapdat-note").hidden,
    checked: document.getElementById("mapdat-on").checked,
  }))()`);
  check("map data is off by default", mapdatOff.checked === false && mapdatOff.note === true,
    JSON.stringify(mapdatOff));

  await s.evaluate(`(() => {
    const el = document.getElementById("mapdat-on");
    el.checked = true;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    const sheet = document.getElementById("sheet-on");
    sheet.checked = true;
    sheet.dispatchEvent(new Event("change", { bubbles: true }));
    window.__dl = [];
    document.getElementById("export-download").click();
  })()`);
  await s.evaluate(`new Promise((r) => setTimeout(r, 5000))`);
  const dats = await s.evaluate(`(async () => {
    const d = window.__dl[0];
    if (!d) return { count: window.__dl.length, name: null };
    const b = new Uint8Array(await d.blob.arrayBuffer());
    const text = new TextDecoder("latin1").decode(b);
    return {
      count: window.__dl.length,
      name: d.name,
      note: document.getElementById("mapdat-note").hidden,
      example: document.getElementById("mapdat-example").textContent,
      dats: [...new Set([...text.matchAll(/map_\\d+\\.dat/g)].map((m) => m[0]))],
      nbts: [...new Set([...text.matchAll(/arachne\\.nbt/g)].map((m) => m[0]))],
      status: document.getElementById("status").textContent,
    };
  })()`);
  check("turning map data on explains where the file goes",
    dats.note === false && dats.example === "7", JSON.stringify({ note: dats.note, example: dats.example }));
  check("one click gives one file, named what the visitor named it",
    dats.count === 1 && dats.name === "arachne.zip", JSON.stringify({ count: dats.count, name: dats.name }));
  check("that one file carries the schematic and every map data file",
    JSON.stringify(dats.nbts) === JSON.stringify(["arachne.nbt"])
      && JSON.stringify(dats.dats)
        === JSON.stringify(["map_7.dat", "map_8.dat", "map_9.dat", "map_10.dat"]),
    JSON.stringify({ nbts: dats.nbts, dats: dats.dats }));
  check("it says how many files it bundled", /6 files in arachne\.zip/.test(dats.status), dats.status);

  const sheet = await s.evaluate(`(async () => {
    const d = window.__dl[0];
    const b = new Uint8Array(await d.blob.arrayBuffer());
    const text = new TextDecoder("latin1").decode(b);
    const at = text.indexOf("Made with Arachne");
    return {
      named: text.includes("arachne.txt"),
      body: at < 0 ? null : text.slice(at, at + 700),
    };
  })()`);
  check("the zip carries a build sheet named after the map", sheet.named === true);
  check("the sheet reopens the palette and lists materials",
    sheet.body !== null && /#p=[A-Za-z0-9_-]{7,}/.test(sheet.body)
      && /Materials/.test(sheet.body) && /shulkers/.test(sheet.body),
    (sheet.body || "").slice(0, 220).replace(/\\n/g, " | "));

  await s.evaluate(`(() => {
    const el = document.getElementById("mapdat-on");
    el.checked = false;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);

  const mouse = async (type, x, y) => {
    await s.send("Input.dispatchMouseEvent", {
      type, x, y, button: "left", clickCount: 1, buttons: type === "mouseMoved" ? 0 : 1,
    });
  };

  await s.evaluate(`(() => {
    const el = document.getElementById("split-export");
    el.checked = true;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("view-build").click();
  })()`, { userGesture: true });
  await s.evaluate(`new Promise((r) => setTimeout(r, 3000))`);
  const opened = await s.evaluate(`(() => {
    const root = document.querySelector(".view2d");
    if (!root) return { open: false };
    const cv = root.querySelector("canvas");
    const sel = root.querySelector("select");
    return {
      open: true,
      painted: cv.toDataURL().length > 2000,
      panels: sel ? [...sel.options].map((o) => o.textContent) : null,
      size: root.querySelector(".view2d-size").textContent,
    };
  })()`);
  check("the viewer opens on the split build", opened.open === true);
  check("it draws the schematic", opened.painted === true);
  check("panels are labelled by grid position and map id",
    JSON.stringify(opened.panels) === JSON.stringify(["x0_z0_map_7", "x1_z0_map_8",
      "x0_z1_map_9", "x1_z1_map_10"]),
    JSON.stringify(opened.panels));
  check("a split panel is 128 wide and carries its reference row",
    /^size: 128 x \d+ x 129$/.test(opened.size), opened.size);

  const box = await s.evaluate(`(() => {
    const r = document.querySelector(".view2d canvas").getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await mouse("mousePressed", box.x, box.y);
  await mouse("mouseReleased", box.x, box.y);
  await s.evaluate(`new Promise((r) => setTimeout(r, 400))`);
  const picked = await s.evaluate(`(() => {
    const w = document.querySelector(".view2d-waila");
    return { coords: w.querySelector(".view2d-coords")?.textContent ?? "",
             name: w.querySelector(".view2d-name")?.textContent ?? "" };
  })()`);
  check("clicking a block names it and gives its coordinates",
    /^x \d+\s+y \d+\s+z \d+$/.test(picked.coords) && picked.name.length > 0,
    `${picked.coords} :: ${picked.name}`);

  await s.evaluate(`(() => {
    const sel = document.querySelector(".view2d select");
    sel.value = "2";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await s.evaluate(`new Promise((r) => setTimeout(r, 2500))`);
  const switched = await s.evaluate(`(() => {
    const root = document.querySelector(".view2d");
    return { painted: root.querySelector("canvas").toDataURL().length > 2000,
             cleared: root.querySelector(".view2d-coords") === null };
  })()`);
  check("switching panels redraws and drops the old selection",
    switched.painted === true && switched.cleared === true);

  await s.evaluate(`document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await s.evaluate(`new Promise((r) => setTimeout(r, 300))`);
  check("escape closes the viewer",
    (await s.evaluate(`document.querySelector(".view2d") === null`)) === true);

  await s.evaluate(`(() => {
    const el = document.getElementById("split-export");
    el.checked = false;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("view-build").click();
  })()`, { userGesture: true });
  await s.evaluate(`new Promise((r) => setTimeout(r, 3500))`);
  const wholeBuild = await s.evaluate(`(() => {
    const root = document.querySelector(".view2d");
    if (!root) return { open: false };
    return { open: true, sel: root.querySelector("select") !== null,
             size: root.querySelector(".view2d-size").textContent };
  })()`);
  check("the joined build views whole, with no panel picker",
    wholeBuild.open === true && wholeBuild.sel === false, JSON.stringify(wholeBuild));
  check("the joined view spans every map plus one reference row",
    /^size: 256 x \d+ x 257$/.test(wholeBuild.size ?? ""), wholeBuild.size);
  await s.evaluate(`document.querySelector(".view2d .mini").click()`, { userGesture: true });
  await s.evaluate(`new Promise((r) => setTimeout(r, 300))`);
  check("close button dismisses the viewer",
    (await s.evaluate(`document.querySelector(".view2d") === null`)) === true);

  const basis = await s.evaluate(`(() => {
    const total = () => [...document.querySelectorAll(".materials tbody tr")]
      .map((tr) => Number(tr.children[2].textContent.replace(/,/g, "")))
      .reduce((a, b) => a + b, 0);
    const sel = document.getElementById("materials-basis");
    const shown = !document.getElementById("materials-basis-label").hidden;
    const options = [...sel.options].map((o) => o.textContent);
    const build = total();
    const panels = [];
    for (const o of [...sel.options].filter((o) => o.value !== "build")) {
      sel.value = o.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      panels.push(total());
    }
    const note = document.querySelector("#summary .note")?.textContent ?? "";
    return { shown, options, build, panels, note };
  })()`);
  check("the panel selector appears once there is more than one map", basis.shown === true);
  check("panels are listed by position and map id",
    JSON.stringify(basis.options)
      === JSON.stringify(["the whole schematic", "panel 1: x0_z0_map_7", "panel 2: x1_z0_map_8",
        "panel 3: x0_z1_map_9", "panel 4: x1_z1_map_10"]),
    JSON.stringify(basis.options));
  check("whole schematic counts 4 maps of blocks", basis.build === 4 * 128 * 128,
    `${basis.build} blocks`);
  check("each panel counts one map of blocks",
    basis.panels.length === 4 && basis.panels.every((n) => n === 128 * 128),
    JSON.stringify(basis.panels));
  check("panels add up to the whole schematic",
    basis.panels.reduce((a, b) => a + b, 0) === basis.build);
  check("a panel summary says which panel it is for", /panel 4 of 4, x1_z1_map_10/.test(basis.note),
    basis.note.slice(0, 60));

  const clamped = await s.evaluate(`(() => {
    const typed = (id, v) => {
      const el = document.getElementById(id);
      el.value = v;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value;
    };
    return {
      overMax: typed("maps-w", "99"),
      underMin: typed("haste", "-5"),
      blankStaysBlank: typed("cliff-cap", ""),
      inRange: typed("first-map-id", "12"),
      eff: (() => {
        const el = document.querySelector('#loadout input[type="number"]');
        el.value = "900";
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return el.value;
      })(),
    };
  })()`);
  check("over-max entry snaps to the max", clamped.overMax === "16", clamped.overMax);
  check("under-min entry snaps to the min", clamped.underMin === "0", clamped.underMin);
  check("blank stays blank where blank means unset", clamped.blankStaysBlank === "");
  check("in-range entry is left alone", clamped.inRange === "12", clamped.inRange);
  check("rebuilt loadout fields clamp too", clamped.eff === "255", clamped.eff);

  const PRESET = "0R1R2R3Q4R5Q6Q7Q8T9RbRcSdWeAfTgThXiTjXlTmTnXoTpAqWrTsEtQuRvQwQxVyQzR10Q"
    + "11Q12Q13Q14Q15Q16Q17Q18R19Q1aQ1bQ1cQ1dQ1eQ1fQ1gS1hQ1iQ1jS1kQ1lQ1mQ1nQ1oR";
  const imported = await s.evaluate(`(async () => {
    const box = document.getElementById("import-paste");
    box.value = ${JSON.stringify(`https://rebane2001.com/mapartcraft/?preset=${"PRESET_PLACEHOLDER"}`)}
      .replace("PRESET_PLACEHOLDER", ${JSON.stringify(PRESET)});
    document.getElementById("import-apply").click();
    await new Promise((r) => setTimeout(r, 3000));
    const ws = ${WORKSPACE};
    return {
      status: document.getElementById("io-result").textContent,
      meta: document.getElementById("color-meta").textContent,
      enabled: ws.enabled.length,
      picks: Object.keys(ws.picks).length,
      slime: ws.picks["1"],
      deliberate: (ws.deliberate || []).length,
      banner: document.querySelector(".drift-banner")?.textContent?.trim() ?? null,
    };
  })()`);
  check("a mapartcraft link imports", /Imported 59 colors/.test(imported.status), imported.status);
  check("colors the palette leaves out are switched off",
    imported.meta === "59 of 61 colors, 2 turned off" && imported.enabled === 59, imported.meta);
  check("every color keeps the block they chose", imported.picks === 59, `${imported.picks} picks`);
  check("blocks resolve through the generated table, not by guess",
    imported.slime === "slime_block", String(imported.slime));
  check("an imported palette counts as chosen on purpose",
    imported.deliberate === imported.picks, `${imported.deliberate} of ${imported.picks}`);
  check("so importing does not immediately nag about the blocks you asked for",
    imported.banner === null, String(imported.banner));

  const roundTrip = await s.evaluate(`(async () => {
    window.__dl = [];
    document.getElementById("export-settings").click();
    await new Promise((r) => setTimeout(r, 600));
    const text = await window.__dl[0].blob.text();
    document.getElementById("colors-none").click();
    await new Promise((r) => setTimeout(r, 1200));
    const emptied = document.getElementById("color-meta").textContent;
    const dt = new DataTransfer();
    dt.items.add(new File([text], "arachne-settings.json", { type: "application/json" }));
    const input = document.getElementById("import-file");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 2500));
    return {
      name: window.__dl[0].name,
      emptied,
      restored: document.getElementById("color-meta").textContent,
      picks: Object.keys(${WORKSPACE}.picks).length,
    };
  })()`);
  check("settings export is a named file", /-settings\.json$/.test(roundTrip.name), roundTrip.name);
  check("settings round-trip restores the palette",
    roundTrip.emptied === "0 of 61 colors, 61 turned off"
      && roundTrip.restored === "59 of 61 colors, 2 turned off" && roundTrip.picks === 59,
    `${roundTrip.emptied} -> ${roundTrip.restored}, ${roundTrip.picks} picks`);

  const wear = await s.evaluate(`(async () => {
    const read = () => {
      const dt = [...document.querySelectorAll("#summary dt")]
        .find((e) => e.textContent === "tools you need");
      return { tools: dt.nextElementSibling.textContent.trim(),
               teardown: [...document.querySelectorAll("#summary dt")]
                 .find((e) => e.textContent === "time to take down").nextElementSibling.textContent };
    };

    const basis = document.getElementById("materials-basis");
    basis.value = "build";
    basis.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    const item = document.querySelectorAll(".tool-item")[0];
    const fire = (sel, v, prop = "value") => {
      const el = item.querySelector(sel);
      el[prop] = v;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    fire(".tool-mending", false, "checked");
    fire(".tool-unbreaking", "0");
    await new Promise((r) => setTimeout(r, 800));
    const plain = read();
    fire(".tool-unbreaking", "3");
    await new Promise((r) => setTimeout(r, 800));
    const unbreaking = read();
    fire(".tool-mending", true, "checked");
    await new Promise((r) => setTimeout(r, 800));
    const mending = read();
    fire(".tool-unbreakable", true, "checked");
    await new Promise((r) => setTimeout(r, 800));
    const unbreakable = read();
    return { plain, unbreaking, mending, unbreakable };
  })()`);
  check("summary says how many tools to bring", /bring \d+/.test(wear.plain.tools),
    wear.plain.tools.slice(0, 90));
  check("unbreaking makes tools last longer",
    wear.unbreaking.tools !== wear.plain.tools && /bring \d+/.test(wear.unbreaking.tools),
    wear.unbreaking.tools.slice(0, 90));
  check("unbreaking does not change breaking time",
    wear.unbreaking.teardown === wear.plain.teardown,
    `${wear.plain.teardown} -> ${wear.unbreaking.teardown}`);
  check("mending collapses the tool count to one",
    /Mending, bring one and repair as you go/.test(wear.mending.tools),
    wear.mending.tools.slice(0, 90));
  check("mending does not change breaking time",
    wear.mending.teardown === wear.plain.teardown,
    `${wear.plain.teardown} -> ${wear.mending.teardown}`);
  check("unbreakable tools never wear out",
    /unbreakable, one is enough/.test(wear.unbreakable.tools),
    wear.unbreakable.tools.slice(0, 90));

  const xss = await s.evaluate(`(async () => {
    const nick = document.querySelectorAll(".tool-item")[0].querySelector("input.nick");
    nick.value = '<img src=x onerror="window.__xss=1">';
    nick.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    return {
      injected: !!document.querySelector("#summary img"),
      executed: window.__xss === 1,
      shown: document.querySelector("#summary dl").textContent.includes("<img src=x"),
    };
  })()`);
  check("a tool nickname cannot inject markup into the summary",
    xss.injected === false && xss.executed === false, JSON.stringify(xss));
  check("the nickname still displays, escaped", xss.shown === true, JSON.stringify(xss));

  const vocab = await s.evaluate(`(() => {
    const view = document.getElementById("palette-view");
    view.value = "list";
    view.dispatchEvent(new Event("change", { bubbles: true }));
    const chips = [...new Set([...document.querySelectorAll(".flag")].map((e) => e.textContent))];
    const filters = [...document.querySelectorAll("#toggles label")]
      .map((l) => l.textContent.trim().split(": ")[0]);
    return {
      chips,
      filters,
      inPalette: !!document.querySelector("#solver-panel #toggles"),
      orphans: chips.filter((c) => !filters.includes(c)),
    };
  })()`);
  check("the block filters live in the palette panel", vocab.inPalette === true);
  check("every flag on a block is a filter you can find by the same word",
    vocab.chips.length > 0 && vocab.orphans.length === 0,
    `chips ${JSON.stringify(vocab.chips)} orphans ${JSON.stringify(vocab.orphans)}`);

  const filler = await s.evaluate(`(async () => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = v;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const enabledNow = () => document.getElementById("color-meta").textContent;
    set("palette-view", "tiles");
    await new Promise((r) => setTimeout(r, 500));
    const tile = [...document.querySelectorAll(".palette-row .tile:not(.none-tile)")]
      .find((t) => /\\bsupport\\b/.test(t.title));
    if (tile) tile.click();
    await new Promise((r) => setTimeout(r, 800));
    set("height-mode", "stepped");
    set("support-mode", "none");
    await new Promise((r) => setTimeout(r, 500));
    const stepped = {
      text: document.getElementById("filler-notice").textContent,
      warn: document.getElementById("filler-notice").className.includes("warn"),
      palette: enabledNow(),
    };
    set("height-mode", "flat");
    await new Promise((r) => setTimeout(r, 1500));
    const flat = {
      text: document.getElementById("filler-notice").textContent,
      warn: document.getElementById("filler-notice").className.includes("warn"),
    };
    set("support-mode", "important");
    await new Promise((r) => setTimeout(r, 500));
    const withFiller = document.getElementById("filler-notice").hidden;
    return { stepped, flat, withFiller };
  })()`);
  check("no filler under a staircase is priced, not just warned",
    /pop off/.test(filler.stepped.text) && /\d/.test(filler.stepped.text)
      && filler.stepped.warn === true, filler.stepped.text.slice(0, 90));
  check("no filler on a flat canvas is stated, not warned",
    /rest directly on your canvas/.test(filler.flat.text) && filler.flat.warn === false,
    filler.flat.text.slice(0, 90));
  check("the staircase case offers the fix that matches the intent",
    /add filler where needed/.test(filler.stepped.text), filler.stepped.text.slice(-60));
  check("the palette is never edited behind the artist",
    filler.stepped.palette === "59 of 61 colors, 2 turned off", filler.stepped.palette);
  check("the notice clears once filler is on", filler.withFiller === true);

  const hostile = await s.evaluate(`(async () => {
    const doc = {
      arachne: 1,
      enabled: [1, 2, 3],
      picks: {},
      tools: [
        { kind: "drill", tier: "adamantium", efficiency: 1e9, silk: "yes",
          unbreaking: -5, nick: "x".repeat(200) },
      ],
      toggles: { gravity: false },
      fields: { "maps-w": "9999", haste: "-3" },
    };
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(doc)], "evil.json", { type: "application/json" }));
    const input = document.getElementById("import-file");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 3000));
    const ws = ${WORKSPACE};
    return {
      status: document.getElementById("status").textContent,
      tool: ws.tools[0],
      mapsW: document.getElementById("maps-w").value,
      haste: document.getElementById("haste").value,
      rows: document.querySelectorAll(".palette-row, .prow").length,
      undo: [...document.querySelectorAll("#io-result button")].map((b) => b.textContent),
    };
  })()`);
  check("unknown tool kind and tier fall back rather than break the solver",
    hostile.tool.kind === "pickaxe" && hostile.tool.tier === "netherite",
    JSON.stringify(hostile.tool));
  check("out-of-range enchant levels are clamped before they are stored",
    hostile.tool.efficiency === 255 && hostile.tool.unbreaking === 0,
    `eff=${hostile.tool.efficiency} unb=${hostile.tool.unbreaking}`);
  check("a nickname cannot grow without bound", hostile.tool.nick.length === 40,
    `${hostile.tool.nick.length} chars`);
  check("restored fields are clamped to what the build will use",
    hostile.mapsW === "16" && hostile.haste === "0",
    `maps-w=${hostile.mapsW} haste=${hostile.haste}`);
  check("the app still renders after a hostile import", hostile.rows === 61,
    `${hostile.rows} rows`);
  check("an import can be undone", hostile.undo.includes("undo"),
    JSON.stringify(hostile.undo));

  const preview = await s.evaluate(`(async () => {
    const set = (id, v) => {
      const e = document.getElementById(id);
      e.value = v;
      e.dispatchEvent(new Event("change", { bubbles: true }));
    };
    set("maps-w", "4"); set("maps-h", "4");
    document.getElementById("zoom-fit").click();   // earlier sections raised it
    await new Promise((r) => setTimeout(r, 6000));
    const probe = () => {
      const panel = document.getElementById("preview-panel");
      const slot = document.getElementById("preview-slot");
      const cv = document.getElementById("preview");
      const w = Math.round(cv.getBoundingClientRect().width);
      return {
        shown: w,
        slot: slot.clientWidth,
        fits: w <= slot.clientWidth + 1,
        scrolls: slot.scrollWidth > slot.clientWidth + 1
          || panel.scrollHeight > panel.clientHeight + 1,
        zoomed: panel.classList.contains("zoomed"),
        sticky: getComputedStyle(panel).position === "sticky",
        inline: document.body.classList.contains("preview-inline"),
        canvas: cv.width,
      };
    };
    const steps = { fit: probe() };
    document.getElementById("zoom-in").click();
    await new Promise((r) => setTimeout(r, 300));
    steps.zoom1 = probe();
    document.getElementById("zoom-in").click();
    document.getElementById("zoom-in").click();
    document.getElementById("zoom-in").click();
    await new Promise((r) => setTimeout(r, 300));
    steps.capped = probe();
    document.getElementById("zoom-fit").click();
    await new Promise((r) => setTimeout(r, 300));
    steps.back = probe();
    document.getElementById("preview-place").click();
    await new Promise((r) => setTimeout(r, 300));
    steps.inline = probe();
    document.getElementById("preview-place").click();
    await new Promise((r) => setTimeout(r, 300));
    steps.railback = probe();
    const grid = document.getElementById("grid-overlay");
    grid.checked = true;
    grid.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    steps.names = {
      count: document.querySelectorAll(".grid-name").length,
      first: document.querySelector(".grid-name")?.textContent ?? "",
      base: document.getElementById("first-map-id").value || "0",
    };
    grid.checked = false;
    grid.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("preview-toggle").click();
    await new Promise((r) => setTimeout(r, 300));
    steps.hidden = {
      label: document.getElementById("preview-toggle").textContent,
      visible: document.getElementById("preview-slot").offsetParent !== null,
    };
    document.getElementById("preview-toggle").click();
    return steps;
  })()`);
  check("a 4x4 build fits the rail whole at 1:1",
    preview.fit.canvas === 512 && preview.fit.fits && !preview.fit.zoomed,
    `${preview.fit.canvas}px canvas shown at ${preview.fit.shown} in ${preview.fit.slot}`);
  check("zooming grows the preview without leaving the rail",
    preview.zoom1.zoomed && preview.zoom1.shown > preview.fit.shown
      && preview.zoom1.fits && preview.zoom1.sticky,
    `${preview.fit.shown} -> ${preview.zoom1.shown} in ${preview.zoom1.slot}`);
  check("zoom is capped at what is on screen", preview.capped.fits,
    `${preview.capped.shown} in ${preview.capped.slot}`);
  check("the preview never scrolls inside its own box",
    [preview.fit, preview.zoom1, preview.capped, preview.back,
      preview.inline].every((p) => !p.scrolls));
  check("fit returns it to the rail",
    preview.back.shown === preview.fit.shown && !preview.back.zoomed);
  check("the preview can sit in the page instead",
    preview.inline.inline && preview.inline.fits && !preview.inline.sticky,
    `${preview.inline.shown} in ${preview.inline.slot}`);
  check("and come back to the scrolling rail",
    !preview.railback.inline && preview.railback.sticky);
  check("the grid names panels the way the download does",
    preview.names.count === 16
      && preview.names.first === `x0 z0 · map ${preview.names.base}`,
    `${preview.names.count} labels, first "${preview.names.first}"`);
  check("the preview can be collapsed and brought back",
    preview.hidden.visible === false && /show preview/.test(preview.hidden.label),
    preview.hidden.label);

  const adj = await s.evaluate(`(async () => {
    const px = () => JSON.stringify([...document.getElementById("preview")
      .getContext("2d").getImageData(0, 0, 24, 24).data]);
    const set = (id, v) => { const e = document.getElementById(id); e.value = v;
      e.dispatchEvent(new Event("change", { bubbles: true })); };
    document.getElementById("colors-all").click();
    await new Promise((r) => setTimeout(r, 4000));
    if (document.getElementById("preview-slot").offsetParent === null) {
      document.getElementById("preview-toggle").click();
      await new Promise((r) => setTimeout(r, 1200));
    }
    const out = { startHidden: getComputedStyle(document.getElementById("adjust-controls")).display };
    const before = px();
    const on = document.getElementById("adjust-on");
    on.checked = true; on.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 3000));
    out.shown = getComputedStyle(document.getElementById("adjust-controls")).display !== "none";
    out.neutralSame = px() === before;
    out.chipWhenNeutral = !document.getElementById("adjust-state").hidden;
    set("adj-temperature", "-70");
    await new Promise((r) => setTimeout(r, 6000));
    out.cooledDiffers = px() !== before;
    out.meta = document.getElementById("color-meta").textContent;
    out.chip = document.getElementById("adjust-state").textContent;
    document.getElementById("adjust-reset").click();
    await new Promise((r) => setTimeout(r, 6000));
    out.resetRestores = px() === before;
    out.chipAfterReset = !document.getElementById("adjust-state").hidden;
    on.checked = false; on.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 2000));
    return out;
  })()`);
  check("adjustments stay out of the way until switched on",
    adj.startHidden === "none" && adj.shown === true, adj.startHidden);
  check("switching them on with everything neutral changes nothing", adj.neutralSame === true);
  check("and says nothing is adjusted yet", adj.chipWhenNeutral === false);
  check("cooling the picture changes the render", adj.cooledDiffers === true, adj.meta);
  check("the page says which adjustment is active", /temperature/.test(adj.chip || ""), adj.chip);
  check("neutral puts it back exactly", adj.resetRestores === true);
  check("and drops the indicator", adj.chipAfterReset === false);

  const bg = await s.evaluate(`(async () => {
    const out = { opaqueHidden: getComputedStyle(document.getElementById("background-row")).display };
    const drop = async (name, cut) => {
      const c = document.createElement("canvas"); c.width = 128; c.height = 128;
      const g = c.getContext("2d"); g.fillStyle = "#3080c0"; g.fillRect(0, 0, 128, 128);
      if (cut) g.clearRect(32, 32, 64, 64);
      const b = await new Promise((r) => c.toBlob(r));
      const dt = new DataTransfer();
      dt.items.add(new File([b], name, { type: "image/png" }));
      document.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 7000));
    };
    const at = () => { const c = document.getElementById("preview");
      return [...c.getContext("2d")
        .getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data]; };
    const alpha = document.getElementById("honor-alpha");
    if (!alpha.checked) { alpha.checked = true;
      alpha.dispatchEvent(new Event("change", { bubbles: true })); }
    await drop("holes.png", true);
    out.shownWithAlpha = getComputedStyle(document.getElementById("background-row")).display !== "none";
    out.holePixel = at();
    const m = document.getElementById("bg-mode");
    m.value = "smooth"; m.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 6000));
    out.filledPixel = at();
    out.note = document.getElementById("bg-note").textContent;
    alpha.checked = false;
    alpha.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 4000));
    alpha.checked = true;
    alpha.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 6000));
    out.modeAfterHonor = document.getElementById("bg-mode").value;
    out.holeAgain = at();
    out.noteAfterHonor = document.getElementById("bg-note").textContent;
    m.value = "off"; m.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5000));
    return out;
  })()`);
  check("nothing to fill, nothing offered", bg.opaqueHidden === "none", bg.opaqueHidden);
  check("a see-through source offers to fill it", bg.shownWithAlpha === true);
  check("left alone, see-through stays a hole", bg.holePixel[3] === 0,
    JSON.stringify(bg.holePixel));
  check("filled, it places a block", bg.filledPixel[3] === 255,
    JSON.stringify(bg.filledPixel));
  check("flat fill snaps to a color a map can make",
    /closest color a map can make/.test(bg.note || ""), bg.note);
  check("honoring transparency again stands the fill down",
    bg.modeAfterHonor === "off", bg.modeAfterHonor);
  check("and the see-through part is a hole again", bg.holeAgain[3] === 0,
    JSON.stringify(bg.holeAgain));
  check("the note says the holes are back",
    /place no blocks/.test(bg.noteAfterHonor || ""), bg.noteAfterHonor);

  const starved = await s.evaluate(`(async () => {
    const out = {};
    const boxes = ["toggle-gravity", "toggle-silk_gated", "toggle-flammable",
      "toggle-unstable", "toggle-constrained", "toggle-unrecoverable"];
    const was = {};
    for (const id of boxes) {
      const b = document.getElementById(id);
      was[id] = b.checked;
      if (b.checked) { b.checked = false; b.dispatchEvent(new Event("change", { bubbles: true })); }
    }
    await new Promise((r) => setTimeout(r, 3000));
    const rows = [...document.querySelectorAll(".palette-row")];
    out.unusable = rows.filter((r) => r.classList.contains("unusable")).length;
    out.notice = document.getElementById("palette-notice").textContent.trim();
    document.getElementById("share-link").click();
    await new Promise((r) => setTimeout(r, 2500));
    out.io = document.getElementById("io-result").textContent.trim();
    out.shared = Number((out.io.match(/^(\\d+) colors/) || [])[1] || 0);
    out.onRows = rows.filter((r) => !r.classList.contains("off")).length;
    for (const id of boxes) {
      const b = document.getElementById(id);
      if (b.checked !== was[id]) { b.checked = was[id]; b.dispatchEvent(new Event("change", { bubbles: true })); }
    }
    await new Promise((r) => setTimeout(r, 3000));
    out.unusableAfter = [...document.querySelectorAll(".palette-row")]
      .filter((r) => r.classList.contains("unusable")).length;
    return out;
  })()`);
  check("filters that starve a color mark it, rather than leaving a dead pick",
    starved.unusable > 0, `${starved.unusable} starved`);
  check("and the notice names them", /no block your filters allow/.test(starved.notice || ""),
    (starved.notice || "").slice(0, 90));
  check("a starved palette still shares, minus the colors that place nothing",
    starved.shared === starved.onRows - starved.unusable,
    `${starved.shared} shared vs ${starved.onRows} on - ${starved.unusable} starved`);
  check("re-enabling the filters brings every color back",
    starved.unusableAfter === 0, `${starved.unusableAfter} still starved`);

  const setPreset = async (id) => {
    await s.evaluate(`(() => {
      const sel = document.getElementById("palette-preset");
      sel.value = "${id}";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await s.evaluate(`new Promise((r) => setTimeout(r, 2500))`);
  };
  const paletteState = () => s.evaluate(`(() => {
    const rows = [...document.querySelectorAll(".palette-row")];
    const on = rows.filter((r) => !r.classList.contains("off"));
    return {
      on: on.length,
      picked: on.map((r) => r.querySelector(".tile.selected")?.title?.split("\\n")[0] ?? "").join("|"),
      hash: location.hash,
      result: document.getElementById("io-result").textContent,
    };
  })()`);

  await setPreset("builtin:carpet");
  const shareBefore = await paletteState();
  await s.evaluate(`document.getElementById("share-link").click()`, { userGesture: true });
  await s.evaluate(`new Promise((r) => setTimeout(r, 1500))`);
  const shared = await s.evaluate(`(() => ({
    url: document.getElementById("share-out").value,
    shown: document.getElementById("share-row").hidden === false,
    result: document.getElementById("io-result").textContent,
  }))()`);
  check("a palette link is produced and shown", shared.shown === true && /#p=/.test(shared.url),
    shared.url);
  check("the whole palette fits in a short link", shared.url.length < 120,
    `${shared.url.length} chars`);
  check("it says how much it carried", /\d+ colors in \d+ characters/.test(shared.result),
    shared.result);
  const frag = shared.url.split("#")[1];

  await setPreset("builtin:full");
  const clobbered = await paletteState();
  check("the palette really changed before we replay the link",
    clobbered.on !== shareBefore.on, `${clobbered.on} vs ${shareBefore.on}`);
  await s.evaluate(`location.hash = ${JSON.stringify(frag)}`);
  await s.evaluate(`new Promise((r) => setTimeout(r, 3000))`);
  const pasted = await paletteState();
  check("a link pasted into an open tab restores the palette",
    pasted.on === shareBefore.on && pasted.picked === shareBefore.picked,
    `${pasted.on} vs ${shareBefore.on}`);
  check("the code is taken out of the address bar once used", pasted.hash === "",
    JSON.stringify(pasted.hash));
  check("it says what it loaded",
    /Loaded \d+ colors from a shared palette/.test(pasted.result), pasted.result);

  await setPreset("builtin:full");
  await s.send("Page.navigate", { url: "about:blank" });
  await s.evaluate(`new Promise((r) => setTimeout(r, 500))`);
  await s.send("Page.navigate", { url: shared.url });
  const st = await s.evaluate(WAIT_READY);
  if (String(st).startsWith("TIMEOUT")) throw new Error(`app never became ready: ${st}`);
  await s.evaluate(`new Promise((r) => setTimeout(r, 3500))`);
  const cold = await paletteState();
  check("the same link opened cold restores the same palette",
    cold.on === shareBefore.on && cold.picked === shareBefore.picked,
    `${cold.on} vs ${shareBefore.on}`);

  await s.evaluate(`location.hash = ${JSON.stringify(frag.slice(0, -2))}`);
  await s.evaluate(`new Promise((r) => setTimeout(r, 2000))`);
  const refused = await s.evaluate(`document.getElementById("io-result").textContent`);
  check("a damaged link is refused rather than half-applied",
    /damaged|different block list|truncated|not in it/.test(refused), refused);

  const errors = s.logs.filter((l) => /EXCEPTION|error:/i.test(l));
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  check("dialogs were driven", dialogs.length >= 2, `${dialogs.length}`);
});

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exitCode = failures ? 1 : 0;
