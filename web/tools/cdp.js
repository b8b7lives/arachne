import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const BROWSERS = ["chromium", "chromium-browser", "google-chrome"];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(profile, width, height) {
  for (const bin of BROWSERS) {
    const p = spawn(
      bin,
      [
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--hide-scrollbars",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        `--window-size=${width},${height}`,
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    if (p.pid) return p;
  }
  throw new Error(`no browser found (tried ${BROWSERS.join(", ")})`);
}

async function devtoolsPort(profile) {
  const f = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 80; i++) {
    try {
      const line = fs.readFileSync(f, "utf8").split("\n")[0].trim();
      if (line) return Number(line);
    } catch {}
    await sleep(250);
  }
  throw new Error("chrome never published a devtools port");
}

async function firstPage(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await new Promise((res, rej) => {
        http
          .get({ host: "127.0.0.1", port, path: "/json/list" }, (r) => {
            let b = "";
            r.on("data", (d) => (b += d));
            r.on("end", () => res(JSON.parse(b)));
          })
          .on("error", rej);
      });
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error("devtools endpoint never came up");
}

export async function withBrowser({ width = 1500, height = 1400 } = {}, fn) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "arachne-shot-"));
  let chrome = null;
  try {
    chrome = launch(profile, width, height);
    const page = await firstPage(await devtoolsPort(profile));
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const pending = new Map();
    const handlers = new Map();
    const logs = [];
    let id = 0;

    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
      if (m.method && handlers.has(m.method)) {
        for (const h of handlers.get(m.method)) void h(m.params);
      }
      if (m.method === "Runtime.consoleAPICalled") {
        const text = m.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ");
        if (!text.startsWith("[vite]")) logs.push(`${m.params.type}: ${text}`);
      }
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        logs.push(`EXCEPTION ${d.exception?.description ?? d.text}`);
      }
    });
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const i = ++id;
        pending.set(i, (m) => {
          if (m.error)
            rej(new Error(`${method} failed: ${m.error.message ?? JSON.stringify(m.error)}`));
          else res(m.result);
        });
        ws.send(JSON.stringify({ id: i, method, params }));
      });

    const failPending = (why) => {
      for (const [, settle] of pending) settle({ error: { message: why } });
      pending.clear();
    };
    ws.addEventListener("close", () =>
      failPending("devtools websocket closed, the browser or tab died"),
    );
    ws.addEventListener("error", (e) =>
      failPending(`devtools websocket error: ${e.message ?? "socket error"}`),
    );

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("devtools websocket never opened")), 15000);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener("error", (e) => {
        clearTimeout(t);
        reject(new Error(e.message ?? "websocket error"));
      });
    });
    await send("Runtime.enable");
    await send("Log.enable");
    await send("Page.enable");

    const evaluate = async (expression, { userGesture = false } = {}) => {
      const r = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture,
      });
      if (!r) throw new Error("Runtime.evaluate returned no result");
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      }
      return r.result?.value;
    };

    const on = (method, handler) => {
      if (!handlers.has(method)) handlers.set(method, []);
      handlers.get(method).push(handler);
    };

    try {
      return await fn({ send, evaluate, on, logs, sleep });
    } finally {
      ws.close();
    }
  } finally {
    if (chrome) {
      chrome.kill();
      await sleep(400);
    }
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
}
