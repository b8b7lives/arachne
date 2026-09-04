import fs from "node:fs";
import path from "node:path";
import { withBrowser } from "./cdp.js";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};
const url = flag("--url", process.env.ARACHNE_URL || "http://127.0.0.1:5173/");
const outDir = flag("--out", ".shots/survey");
const dropImage = flag("--drop", "public/atlas.webp");
const only = flag("--only", null);
const assertMode = args.includes("--assert");
const maxPhoneHeight = Number(flag("--max-phone-height", "25000"));

const UA_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const UA_IPAD =
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const UA_ANDROID =
  "Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

const VIEWPORTS = [
  { name: "phone-360", w: 360, h: 800, dsf: 3, ua: UA_ANDROID, touch: true, phone: true },
  { name: "phone-390", w: 390, h: 844, dsf: 3, ua: UA_IOS, touch: true, phone: true },
  { name: "phone-430", w: 430, h: 932, dsf: 3, ua: UA_IOS, touch: true, phone: true },
  { name: "tablet-768", w: 768, h: 1024, dsf: 2, ua: UA_IPAD, touch: true },
  { name: "tablet-1024", w: 1024, h: 768, dsf: 2, ua: UA_IPAD, touch: true },
  { name: "desktop-1440", w: 1440, h: 900, dsf: 1, ua: null, touch: false },
  { name: "desktop-1920", w: 1920, h: 1080, dsf: 1, ua: null, touch: false },
];

const METRICS_JS = `
(function () {
  var vw = window.innerWidth;
  var pageH = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
  function cls(el) { return typeof el.className === "string" ? el.className : ""; }
  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }
  function label(el) {
    var cur = el.parentElement;
    while (cur) {
      if (cur.id) return "#" + cur.id;
      cur = cur.parentElement;
    }
    return "(none)";
  }
  var all = document.querySelectorAll("*");
  var offenders = [];
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (!visible(el)) continue;
    var r = el.getBoundingClientRect();
    var over = Math.max(0, r.right - vw, -r.left);
    if (over > 0.5) offenders.push({ tag: el.tagName.toLowerCase(), id: el.id || null, cls: cls(el), over: Math.round(over), in: label(el) });
  }
  offenders.sort(function (a, b) { return b.over - a.over; });
  var inter = document.querySelectorAll("button, input, select, a, summary, [role=button]");
  var small = [], boxes = [];
  for (var j = 0; j < inter.length; j++) {
    var e = inter[j];
    if (!visible(e)) continue;
    var b = e.getBoundingClientRect();
    var target = e.closest("label") || e;
    var tb = target.getBoundingClientRect();
    boxes.push({ el: e, r: b });
    if (tb.width < 44 || tb.height < 44) {
      small.push({ tag: e.tagName.toLowerCase(), id: e.id || null, cls: cls(e), type: e.type || null, w: Math.round(tb.width), h: Math.round(tb.height), in: label(e) });
    }
  }
  var close = 0, closeBy = {};
  for (var a = 0; a < boxes.length; a++) {
    for (var c = a + 1; c < boxes.length; c++) {
      var ra = boxes[a].r, rb = boxes[c].r;
      if (boxes[a].el.contains(boxes[c].el) || boxes[c].el.contains(boxes[a].el)) continue;
      var dx = Math.max(rb.left - ra.right, ra.left - rb.right, 0);
      var dy = Math.max(rb.top - ra.bottom, ra.top - rb.bottom, 0);
      if (Math.sqrt(dx * dx + dy * dy) < 8) {
        close++;
        var key = cls(boxes[a].el).split(" ")[0] + "|" + cls(boxes[c].el).split(" ")[0];
        closeBy[key] = (closeBy[key] || 0) + 1;
      }
    }
  }
  var minInput = Infinity, minInputEl = null;
  var fields = document.querySelectorAll("input, select, textarea");
  for (var f = 0; f < fields.length; f++) {
    if (!visible(fields[f])) continue;
    var fsz = parseFloat(getComputedStyle(fields[f]).fontSize);
    if (fsz < minInput) { minInput = fsz; minInputEl = (fields[f].id || cls(fields[f]) || fields[f].tagName) + " in " + label(fields[f]); }
  }
  var panels = [];
  var secs = document.querySelectorAll("section[id]");
  for (var p = 0; p < secs.length; p++) {
    var pr = secs[p].getBoundingClientRect();
    if (pr.height <= 0) continue;
    panels.push({ id: secs[p].id, top: Math.round(pr.top + window.scrollY), height: Math.round(pr.height) });
  }
  panels.sort(function (x, y) { return x.top - y.top; });
  var sticky = [];
  for (var s = 0; s < all.length; s++) {
    var pos = getComputedStyle(all[s]).position;
    if ((pos === "fixed" || pos === "sticky") && visible(all[s])) sticky.push({ tag: all[s].tagName.toLowerCase(), id: all[s].id || null, cls: cls(all[s]), position: pos });
  }
  return JSON.stringify({
    vw: vw, overflow: document.documentElement.scrollWidth - vw, pageHeight: pageH,
    offenders: offenders.slice(0, 20), offendersTotal: offenders.length,
    interactive: boxes.length, small: small.length, smallSample: small.slice(0, 20),
    closePairs: close, closeBy: closeBy,
    minInputFont: minInput === Infinity ? null : minInput, minInputEl: minInputEl,
    panels: panels, sticky: sticky,
    hint: (document.getElementById("preview-hint") || {}).textContent || null,
    explains: document.querySelectorAll(".explain").length,
    summaryExplains: document.querySelectorAll("#summary .explain").length,
    view: (document.getElementById("palette-view") || {}).value || null,
    pointer: matchMedia("(pointer: coarse)").matches
  });
})()
`;

const READY_JS = `
new Promise(function (res) {
  var t0 = Date.now();
  (function tick() {
    var st = (document.getElementById("status") || {}).textContent || "";
    if (/^ready/.test(st)) return res(st);
    if (Date.now() - t0 > 20000) return res("TIMEOUT: " + st);
    setTimeout(tick, 300);
  })();
})
`;

const dropJs = (b64) =>
  `(function(){var bytes=Uint8Array.from(atob("${b64}"),function(c){return c.charCodeAt(0)});` +
  `var dt=new DataTransfer();dt.items.add(new File([bytes],"demo.png",{type:"image/png"}));` +
  `document.dispatchEvent(new DragEvent("drop",{dataTransfer:dt,bubbles:true,cancelable:true}));})()`;

const SOLVED_JS = `
new Promise(function (res) {
  var t0 = Date.now();
  (function tick() {
    var n = document.querySelectorAll(".palette-row, .prow").length;
    if (n > 0) return res(n);
    if (Date.now() - t0 > 30000) return res(0);
    setTimeout(tick, 300);
  })();
})
`;

async function fullShot(send, evaluate, sleep, vp, file) {
  const h = Math.ceil(
    Number(
      await evaluate("Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)"),
    ),
  );
  await send("Emulation.setDeviceMetricsOverride", {
    mobile: vp.touch,
    width: vp.w,
    height: h,
    deviceScaleFactor: vp.dsf,
    screenWidth: vp.w,
    screenHeight: h,
  });
  await sleep(400);
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
  await send("Emulation.setDeviceMetricsOverride", {
    mobile: vp.touch,
    width: vp.w,
    height: vp.h,
    deviceScaleFactor: vp.dsf,
    screenWidth: vp.w,
    screenHeight: vp.h,
  });
  await sleep(150);
}

async function run(vp) {
  const result = { name: vp.name, w: vp.w, h: vp.h };
  await withBrowser({ width: vp.w, height: vp.h }, async ({ send, evaluate, sleep, logs }) => {
    await send("Emulation.setDeviceMetricsOverride", {
      mobile: vp.touch,
      width: vp.w,
      height: vp.h,
      deviceScaleFactor: vp.dsf,
      screenWidth: vp.w,
      screenHeight: vp.h,
    });
    await send("Emulation.setTouchEmulationEnabled", { enabled: vp.touch, maxTouchPoints: 5 });
    if (vp.ua) await send("Emulation.setUserAgentOverride", { userAgent: vp.ua });
    await send("Page.navigate", { url });
    await sleep(2000);
    result.ready = await evaluate(READY_JS);
    const first = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(outDir, `${vp.name}-first.png`), Buffer.from(first.data, "base64"));
    result.before = JSON.parse(await evaluate(METRICS_JS));
    await fullShot(send, evaluate, sleep, vp, path.join(outDir, `${vp.name}-full.png`));
    if (dropImage) {
      if (!fs.existsSync(dropImage)) throw new Error(`drop image missing: ${dropImage}`);
      await evaluate(dropJs(fs.readFileSync(dropImage).toString("base64")));
      result.rows = await evaluate(SOLVED_JS);
      await sleep(1500);
      result.after = JSON.parse(await evaluate(METRICS_JS));
      await fullShot(send, evaluate, sleep, vp, path.join(outDir, `${vp.name}-solved.png`));
    }
    result.console = logs.filter((l) => !l.startsWith("log:")).slice(0, 10);
  });
  return result;
}

fs.mkdirSync(outDir, { recursive: true });
const results = [];
let failures = 0;
for (const vp of VIEWPORTS) {
  if (only && !vp.name.includes(only)) continue;
  try {
    const r = await run(vp);
    results.push(r);
    const m = r.after || r.before;
    console.log(
      `${vp.name}: ready="${r.ready}" overflow=${m.overflow}px height=${m.pageHeight}px small=${m.small}/${m.interactive} close=${m.closePairs} view=${m.view} explains=${m.explains}/${m.summaryExplains}`,
    );
    if (assertMode && vp.phone) {
      if (!/^ready/.test(r.ready)) {
        failures++;
        console.log(`  FAIL not ready: ${r.ready}`);
      }
      if (dropImage && !r.rows) {
        failures++;
        console.log("  FAIL no palette rows after drop");
      }
      if (m.overflow > 0) {
        failures++;
        console.log(`  FAIL overflow ${m.overflow}px`);
      }
      if (m.pageHeight > maxPhoneHeight) {
        failures++;
        console.log(`  FAIL height ${m.pageHeight} > ${maxPhoneHeight}`);
      }
      if (m.minInputFont !== null && m.minInputFont < 16) {
        failures++;
        console.log(`  FAIL input font ${m.minInputFont}px ${m.minInputEl}`);
      }
    }
    if (r.console.length) console.log(`  console: ${r.console.join(" | ")}`);
  } catch (e) {
    failures++;
    console.log(`${vp.name}: FAILED ${String(e)}`);
  }
}
fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
if (assertMode && failures) process.exitCode = 1;
