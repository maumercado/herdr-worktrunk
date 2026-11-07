// Minimal terminal UI helpers: alt screen, raw keys, ANSI styling, width-aware truncation.
import { theme } from "./theme.mjs";

const ESC = "\x1b[";
export const style = {
  reset: `${ESC}0m`,
  bold: (s) => `${ESC}1m${s}${ESC}22m`,
  dim: (s) => `${ESC}2m${s}${ESC}22m`,
  inverse: (s) => `${ESC}7m${s}${ESC}27m`,
  fg: (code, s) => `${ESC}${code}m${s}${ESC}39m`,
};
// Colors come from the active theme (your oh-my-posh palette by default).
// Looked up per call so the theme loads only when something is drawn.
const role = (name) => (s) => theme().paint[name](s);
export const tone = {
  good: role("good"),
  bad: role("bad"),
  warn: role("warn"),
  busy: role("busy"),
  muted: role("muted"),
  accent: role("accent"),
  branch: role("branch"),
  path: role("path"),
  info: role("info"),
  text: role("text"),
};

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Display width, counting East Asian wide chars and emoji as 2 columns. */
export function width(s) {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, "")) {
    const cp = ch.codePointAt(0);
    if (cp < 32 || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff);
    w += wide ? 2 : 1;
  }
  return w;
}

/** Truncate plain text to `n` columns with an ellipsis. */
export function fit(s, n) {
  if (n <= 0) return "";
  if (width(s) <= n) return s;
  let out = "";
  for (const ch of s) {
    if (width(out + ch) > n - 1) break;
    out += ch;
  }
  return `${out}…`;
}

export function pad(s, n) {
  const t = fit(s, n);
  return t + " ".repeat(Math.max(0, n - width(t)));
}

export class Screen {
  constructor(out = process.stdout, input = process.stdin) {
    this.out = out;
    this.input = input;
    this.active = false;
    this.onKey = null;
    this._handler = (data) => this.onKey?.(parseKeys(data));
  }

  get cols() {
    return this.out.columns || 80;
  }
  get rows() {
    return this.out.rows || 24;
  }

  enter() {
    if (this.active) return;
    this.active = true;
    if (this.input.isTTY) this.input.setRawMode(true);
    this.input.setEncoding("utf8");
    this.input.on("data", this._handler);
    this.input.resume();
    this.out.write(`${ESC}?1049h${ESC}?25l`);
  }

  /** Hand the terminal back (for a child process that may prompt). */
  leave() {
    if (!this.active) return;
    this.active = false;
    this.input.off("data", this._handler);
    if (this.input.isTTY) this.input.setRawMode(false);
    this.input.pause();
    this.out.write(`${ESC}?25h${ESC}?1049l`);
  }

  draw(lines) {
    const rows = this.rows;
    const body = lines.slice(0, rows).map((l) => `${l}${ESC}0m${ESC}K`);
    while (body.length < rows) body.push(`${ESC}K`);
    this.out.write(`${ESC}H${body.join("\r\n")}`);
  }
}

/** Turn a raw stdin chunk into key names. Pasted text arrives as one chunk of chars. */
export function parseKeys(data) {
  const keys = [];
  const map = {
    "\x1b[A": "up",
    "\x1b[B": "down",
    "\x1b[C": "right",
    "\x1b[D": "left",
    "\x1bOA": "up",
    "\x1bOB": "down",
    "\x1b[5~": "pageup",
    "\x1b[6~": "pagedown",
    "\x1b[H": "home",
    "\x1b[F": "end",
    "\x1b[3~": "delete",
  };
  let i = 0;
  while (i < data.length) {
    const seq = Object.keys(map).find((k) => data.startsWith(k, i));
    if (seq) {
      keys.push(map[seq]);
      i += seq.length;
      continue;
    }
    const ch = data[i];
    if (ch === "\x1b") {
      // Bare Esc, or an unknown sequence we swallow.
      const m = /^\x1b\[[0-9;?]*[A-Za-z~]/.exec(data.slice(i));
      if (m) i += m[0].length;
      else {
        keys.push("esc");
        i += 1;
      }
      continue;
    }
    if (ch === "\r" || ch === "\n") keys.push("enter");
    else if (ch === "\x7f" || ch === "\b") keys.push("backspace");
    else if (ch === "\t") keys.push("tab");
    else if (ch === "\x03") keys.push("ctrl+c");
    else if (ch === "\x15") keys.push("ctrl+u");
    else if (ch === "\x0e") keys.push("down");
    else if (ch === "\x10") keys.push("up");
    else if (ch >= " ") keys.push(ch);
    i += 1;
  }
  return keys;
}
