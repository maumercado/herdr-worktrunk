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
  // Colors: "posh" follows an oh-my-posh palette; "ansi" is the plain 16-color look
  theme: "posh",
  // Path to an oh-my-posh theme (.toml, .json, .yaml). Unset: $POSH_THEME, then the built-in mauposh palette
  ohMyPoshTheme: null,
  // Which built-in palette to use when no theme file is found: "dark" | "light"
  appearance: "dark",
  // Per-role color overrides: { "branch": "#906cff", "good": "lightGreen", ... }
  colors: {},
  // Hex for named colors in the sidebar config: { "lightGreen": "#5fd787", ... }
  namedColors: {},
  // Keep a watcher running so sidebar status follows git changes as they happen
  live: true,
  // Seconds between PR / CI checks while the watcher runs (faster while checks are running)
  prPollSeconds: 30,
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
