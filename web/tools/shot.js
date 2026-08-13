import fs from "node:fs";
import path from "node:path";
import { withBrowser } from "./cdp.js";

const [
  url = process.env.ARACHNE_URL || "http://127.0.0.1:5173/",
  out = ".shots/arachne.png",
  waitMs = "7000",
  width = "1500",
  height = "1400",
] = process.argv.slice(2);

try {
  await withBrowser({ width, height }, async ({ send, evaluate, logs, sleep }) => {
    await send("Page.navigate", { url });
    await sleep(Number(waitMs));

    if (process.env.ARACHNE_EVAL) {
      await evaluate(process.env.ARACHNE_EVAL);
      await sleep(1500);
    }
    const scroll = Number(process.env.ARACHNE_SCROLL || 0);
    if (scroll) {
      await evaluate(`window.scrollTo(0, ${scroll})`);
      await sleep(300);
    }
    const shot = await send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: !process.env.ARACHNE_VIEWPORT,
    });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.data, "base64"));

    const state = await evaluate(`JSON.stringify({
      status: document.getElementById("status")?.textContent ?? null,
      palette: document.getElementById("color-meta")?.textContent ?? null,
      rows: document.querySelectorAll(".palette-row, .prow").length,
      height: document.body.scrollHeight
    })`);

    console.log(`${out} (${(fs.statSync(out).size / 1024).toFixed(0)} kB)`);
    console.log("state:", state);
    if (logs.length) console.log("console:\n  " + logs.slice(0, 20).join("\n  "));
  });
} catch (e) {
  console.error(String(e));
  process.exitCode = 1;
}
