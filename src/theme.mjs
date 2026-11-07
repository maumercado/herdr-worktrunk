// Colors that follow your shell prompt.
//
// The plugin reads the [palette] of an oh-my-posh theme and maps it onto a few
// roles (branch, path, good, bad...). The popup uses those roles directly; the
// Herdr sidebar only takes hex colors in config.toml, so `sidebar-config`
// prints rows with the same colors for you to paste.
//
// Named oh-my-posh colors (lightGreen, red...) are drawn with the matching ANSI
// code in the popup, so your terminal's own palette decides the exact shade,
// same as in the prompt. For the sidebar they become hex (see NAMED_HEX).
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { loadConfig } from "./config.mjs";

// Built-in palettes, from mauposh-dark.toml / mauposh-light.toml.
export const BUILTIN = {
  dark: {
    on: "#cccccc",
    via: "#cccccc",
    folder: "lightBlue",
    branch: "#906cff",
    python: "#906cff",
    rust: "#ff8700",
    go: "#7FD5EA",
    node: "#76b367",
    muted: "#767676",
    arrow: "lightGreen",
    took: "#d4a017",
  },
  light: {
    on: "#333333",
    via: "#333333",
    folder: "blue",
    branch: "#6e3db8",
    python: "#5a3d99",
    rust: "#b85c00",
    go: "#1a7a8f",
    node: "#3d6b20",
    muted: "#555555",
    arrow: "green",
    took: "#d4a017",
  },
};

// Role -> palette keys to try, then a named color. The first keys are the
// ones mauposh uses; the rest cover common palette names in other themes.
const ROLES = {
  branch: [["branch", "git", "git_branch"], "magenta"],
  text: [["on", "via", "text", "foreground"], "white"],
  muted: [["muted", "comment", "dim"], "darkGray"],
  path: [["folder", "path", "directory"], "lightBlue"],
  good: [["arrow", "success", "ok", "green"], "lightGreen"],
  bad: [["error", "fail", "red"], "red"],
  warn: [["rust", "warning", "warn", "orange", "dirty"], "yellow"],
  busy: [["took", "time", "executiontime", "yellow"], "yellow"],
  info: [["go", "info", "cyan", "link"], "cyan"],
};

// oh-my-posh named colors -> ANSI foreground code.
export const NAMED_ANSI = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  darkGray: 90,
  lightRed: 91,
  lightGreen: 92,
  lightYellow: 93,
  lightBlue: 94,
  lightMagenta: 95,
  lightCyan: 96,
  lightWhite: 97,
};

// Hex stand-ins for the sidebar, which needs #RRGGBB. Override any of them
// with "namedColors" in config.json to match your terminal's palette exactly.
export const NAMED_HEX = {
  black: "#000000",
  red: "#f14c4c",
  green: "#23d18b",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  darkGray: "#767676",
  lightRed: "#ff6b6b",
  lightGreen: "#5fd787",
  lightYellow: "#f5f543",
  lightBlue: "#5fafff",
  lightMagenta: "#d670d6",
  lightCyan: "#29b8db",
  lightWhite: "#ffffff",
};

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const expandTilde = (p) => (p?.startsWith("~/") ? `${homedir()}${p.slice(1)}` : p);

/** Pull the [palette] table out of an oh-my-posh theme (TOML, JSON or YAML). */
export function parsePalette(text, file = "") {
  if (/\.json$/i.test(file) || /^\s*\{/.test(text)) {
    try {
      return { ...(JSON.parse(text).palette ?? {}) };
    } catch {
      return {};
    }
  }
  const palette = {};
  if (/\.ya?ml$/i.test(file) || /^palette:\s*$/m.test(text)) {
    const block = /^palette:\s*\n((?:[ \t]+.*\n?)*)/m.exec(text);
    for (const line of (block?.[1] ?? "").split("\n")) {
      const m = /^\s+["']?([\w-]+)["']?\s*:\s*["']?([^"'#\s]+)["']?/.exec(line);
      if (m) palette[m[1]] = m[2];
    }
    return palette;
  }
  // TOML: key = "value" lines under [palette], until the next table.
  let inside = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inside = line === "[palette]";
      continue;
    }
    if (!inside) continue;
    const m = /^["']?([\w-]+)["']?\s*=\s*["']([^"']*)["']/.exec(line);
    if (m) palette[m[1]] = m[2];
  }
  return palette;
}

/** Follow "p:name" references inside a palette. */
function resolveRef(value, palette, depth = 0) {
  if (typeof value !== "string") return null;
  if (value.startsWith("p:") && depth < 8) return resolveRef(palette[value.slice(2)], palette, depth + 1);
  return value;
}

/** Build role -> color (hex or named) from a palette, plus per-role overrides. */
export function rolesFrom(palette, overrides = {}) {
  const out = {};
  for (const [role, [keys, fallback]] of Object.entries(ROLES)) {
    let color = null;
    for (const k of keys) {
      color = resolveRef(palette[k], palette);
      if (color) break;
    }
    out[role] = overrides[role] ?? color ?? fallback;
  }
  out.accent = overrides.accent ?? out.branch;
  return out;
}

/** "#906cff" | "lightGreen" -> SGR foreground parameters, or null. */
export function sgr(color) {
  if (!color) return null;
  if (HEX_RE.test(color)) {
    let h = color.slice(1);
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return `38;2;${r};${g};${b}`;
  }
  return NAMED_ANSI[color] ? String(NAMED_ANSI[color]) : null;
}

/** Any color -> #rrggbb for Herdr's sidebar. */
export function hex(color, named = {}) {
  if (!color) return null;
  if (HEX_RE.test(color)) {
    const h = color.slice(1);
    return `#${(h.length === 3 ? [...h].map((c) => c + c).join("") : h).toLowerCase()}`;
  }
  return (named[color] ?? NAMED_HEX[color] ?? null)?.toLowerCase() ?? null;
}

/**
 * Where the palette comes from, in order:
 *   config "ohMyPoshTheme" (a path), then $POSH_THEME, then the built-in mauposh
 *   palette for config "appearance" ("dark" default, or "light").
 */
export function themeSource(config = loadConfig()) {
  const candidates = [config.ohMyPoshTheme, process.env.POSH_THEME].map(expandTilde).filter(Boolean);
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const palette = parsePalette(readFileSync(file, "utf8"), file);
      if (Object.keys(palette).length) return { name: file, palette };
    } catch {
      /* unreadable: try the next one */
    }
  }
  const mode = config.appearance === "light" ? "light" : "dark";
  return { name: `built-in mauposh-${mode}`, palette: BUILTIN[mode] };
}

let cached;
/** The active theme: roles, plus helpers to paint text with them. */
export function theme(config) {
  if (cached && !config) return cached;
  const cfg = config ?? loadConfig();
  if (cfg.theme === "ansi") {
    // The classic 16-color look, for terminals without truecolor.
    const roles = { branch: null, text: null, muted: "darkGray", path: null, good: "green", bad: "red", warn: "yellow", busy: "cyan", info: "cyan", accent: "magenta" };
    const t = makeTheme("ansi", roles, cfg.namedColors);
    if (!config) cached = t;
    return t;
  }
  const src = themeSource(cfg);
  const t = makeTheme(src.name, rolesFrom(src.palette, cfg.colors ?? {}), cfg.namedColors);
  if (!config) cached = t;
  return t;
}

function makeTheme(name, roles, named = {}) {
  const paint = (role) => {
    const code = sgr(roles[role]);
    return code ? (s) => `\x1b[${code}m${s}\x1b[39m` : (s) => s;
  };
  return {
    name,
    roles,
    paint: Object.fromEntries(Object.keys(roles).map((r) => [r, paint(r)])),
    hex: (role) => hex(roles[role], named ?? {}),
  };
}

/** Herdr config.toml rows that color the plugin's tokens with this theme. */
export function sidebarConfig(t = theme()) {
  const c = (role) => JSON.stringify(t.hex(role) ?? "#cccccc");
  return `# herdr-worktrunk sidebar rows, colored from ${t.name}
# Paste into ~/.config/herdr/config.toml (replaces your [ui.sidebar.spaces] rows).
[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  [
    { token = "$wt_head", fg = ${c("branch")} },
    { token = "$wt_status", fg = ${c("good")}, rules = [
      { contains = "failed", fg = ${c("bad")} },
      { contains = "conflicts", fg = ${c("bad")} },
      { contains = "changes req", fg = ${c("bad")} },
      { contains = "running", fg = ${c("busy")} },
      { contains = "review req", fg = ${c("busy")} },
      { contains = "dirty", fg = ${c("warn")} },
      { contains = "merged", fg = ${c("muted")} },
    ] },
  ],
]
`;
}
