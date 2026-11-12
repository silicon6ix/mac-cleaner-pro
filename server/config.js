// Optional per-Mac settings and the startup undo history, kept outside the repo.
import fs from "node:fs";
import path from "node:path";
import { HOME } from "./util.js";

export const STATE_DIR = process.env.MAC_CLEANER_STATE_DIR || path.join(HOME, ".mac-cleaner-pro");

const DEFAULTS = {
  // DerivedData folders used within this many days are marked "In use" and left unticked.
  inUseDays: 3,
  // Extra DerivedData folder names that are never offered unless unlocked.
  protectDerivedData: [],
};

export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "config.json"), "utf8"));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function readState(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, name), "utf8"));
  } catch {
    return fallback;
  }
}

export function writeState(name, value) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, name), JSON.stringify(value, null, 2));
}
