import { mkdirSync, writeFileSync } from "node:fs";
import { sleep, withBrowser } from "./cdp.js";

const [url = "http://127.0.0.1:5173/", outDir = ".shots"] = process.argv.slice(2);

const SOURCE = `(async () => {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 256;
  const g = c.getContext("2d");
  const sky = g.createLinearGradient(0, 0, 0, 150);
  sky.addColorStop(0, "#5b94db"); sky.addColorStop(1, "#cbe4f7");
  g.fillStyle = sky; g.fillRect(0, 0, 256, 150);
  const ground = g.createLinearGradient(0, 150, 0, 256);
  ground.addColorStop(0, "#6d8c4a"); ground.addColorStop(1, "#3d5228");
  g.fillStyle = ground; g.fillRect(0, 150, 256, 106);
  g.fillStyle = "#f2efe9";
  g.beginPath(); g.arc(196, 46, 26, 0, 7); g.fill();
  const grey = g.createLinearGradient(0, 0, 256, 0);
  grey.addColorStop(0, "#ffffff"); grey.addColorStop(1, "#e1e1e1");
  g.fillStyle = grey; g.fillRect(0, 190, 256, 30);
  const blob = await new Promise((r) => c.toBlob(r));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], "compare.png", { type: "image/png" }));
  document.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
})()`;

mkdirSync(outDir, { recursive: true });

await withBrowser({ width: 1500, height: 1200 }, async ({ evaluate, send }) => {
  await send("Page.navigate", { url });
  await sleep(9000);
  await evaluate(SOURCE);
  await sleep(3500);

  const modes = process.env.DITHERS
    ? process.env.DITHERS.split(",")
    : ["floyd_steinberg", "bayer4", "yliluoma_bayer4"];
  for (const spec of modes) {
    const [mode, refine] = spec.split("+");
    await evaluate(`(() => {
      const s = document.getElementById("dither");
      s.value = ${JSON.stringify(mode)};
      const r = document.getElementById("dbs-refine");
      r.checked = ${refine === "dbs"};
      s.dispatchEvent(new Event("change", { bubbles: true }));
      r.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await sleep(7000);
    const data = await evaluate(
      `document.getElementById("preview").toDataURL().slice("data:image/png;base64,".length)`,
    );
    if (!data || data.length < 1000) {
      console.error(`${spec}: no preview`);
      continue;
    }
    const path = `${outDir}/dither-${spec.replace("+", "-")}.png`;
    writeFileSync(path, Buffer.from(data, "base64"));
    console.log(`${spec.padEnd(24)} -> ${path}`);
  }
});
