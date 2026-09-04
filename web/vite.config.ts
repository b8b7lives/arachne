import { execSync } from "node:child_process";
import { defineConfig } from "vite";

function buildId(): string {
  try {
    const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim() !== "";
    return dirty ? `${sha}+local` : sha;
  } catch {
    return "unknown";
  }
}

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/arachne/" : "/",
  appType: "mpa",
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: "index.html",
        colors: "colors/index.html",
        changelog: "changelog/index.html",
        sw: "src/sw.ts",
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
      },
    },
  },
  worker: { format: "es" },
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
}));
