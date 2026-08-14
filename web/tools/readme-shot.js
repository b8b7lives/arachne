import { readFileSync } from "node:fs";
import { withBrowser } from "./cdp.js";

const url = process.argv[2] || "http://127.0.0.1:5173/";
const img = process.argv[3] || "../media-src/demo.png";
const out = process.argv[4] || "../media/screenshot.png";

const b64 = readFileSync(img).toString("base64");

await withBrowser({ width: 1440, height: 900 }, async (s) => {
  await s.send("Page.navigate", { url });
  await s.evaluate(`new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      const st = document.getElementById("status")?.textContent ?? "";
      if (/^ready/.test(st) && document.querySelector(".palette-row")) return res(st);
      if (Date.now() - t0 > 15000) return res("TIMEOUT: " + st);
      setTimeout(tick, 200);
    };
    tick();
  })`);
  await s.evaluate(`(() => {
    const hide = [...document.querySelectorAll("#whatsnew-notice button")]
      .find((b) => b.textContent === "hide");
    if (hide) hide.click();
  })()`);
  await s.evaluate(`(async () => {
    const bytes = Uint8Array.from(atob("${b64}"), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "demo.png", { type: "image/png" }));
    document.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  })()`);
  await s.evaluate(`new Promise((r) => setTimeout(r, 6000))`);
  const shot = await s.send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`${out} written`);
});
