// Optional user config at $(herdr plugin config-dir maumercado.worktrunk)/config.json
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULTS = {
  // Where Enter opens a worktree from the list: "space" | "tab" | "split" | "split-down"
  defaultOpen: "space",
  // After creating a worktree: "ask" shows the open menu, or one of the targets above, or "none"
  afterCreate: "ask",
  // Close Herdr Spaces and panes that sit inside a worktree when it is removed
  closePanesOnRemove: true,
  // Start the picker with branches that have no worktree listed (toggle with b)
  showBranches: false,
  // Minimum seconds between status syncs triggered by Herdr events (new Spaces always sync)
  syncThrottleSeconds: 8,
  // "nerd" needs a Nerd Font in your terminal; "unicode" works with any font
  icons: "nerd",
  // Absolute path to wt when Herdr's server does not have it on PATH
  wtBin: null,
};

export function loadConfig() {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!dir) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}
