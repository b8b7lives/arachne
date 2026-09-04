import { readFileSync } from "node:fs";
import { basename } from "node:path";

export const SITE = "https://b8b7.live/arachne/";
export const OG_IMAGE = "https://b8b7.live/assets/brand/og-card.jpg";
export const OG_ALT = "A rolled Minecraft map sealed with a spider medallion";
export const THEME_COLOR = "#16181d";

export const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const tool = basename(process.argv[1] || "tool");

export const fail = (msg) => {
  console.error(`${tool}: ${msg}`);
  process.exit(1);
};

export const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return fail(`cannot read ${path}: ${e.message}`);
  }
};
