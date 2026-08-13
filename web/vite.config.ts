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
  build: { target: "es2022" },
  worker: { format: "es" },
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
}));
