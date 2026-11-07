// The popup UI: list worktrees, open them as a Space / tab / split, create, remove.
import { basename } from "node:path";
import { homedir } from "node:os";
import { Screen, style, tone, fit, pad, width } from "./tui.mjs";
import {
  invocationContext,
  listWorkspaces,
  listPanes,
  openAsSpace,
  openAsTab,
  openAsSplit,
  herdrQuiet,
  notify,
} from "./herdr.mjs";
import {
  repoOf,
  wtList,
  wtListAsync,
  worktreeItems,
  primaryOf,
  wtSwitch,
  wtRemove,
  canon,
  isInside,
  prRefFromUrl,
} from "./wt.mjs";
import { run } from "./exec.mjs";
import { describe, isDirty } from "./status.mjs";
import { workspaceDir } from "./sync.mjs";
import { loadConfig } from "./config.mjs";
import { icons, lead } from "./icons.mjs";

const TARGET_KEYS = { enter: null, t: "tab", v: "split", "-": "split-down", s: "space" };
const TARGET_LABEL = { space: "Space", tab: "tab", split: "split", "split-down": "split below" };

const home = homedir();
const tildify = (p) => (p && p.startsWith(home) ? `~${p.slice(home.length)}` : p);

export function branchExists(dir, name) {
  const res = run(
    "git",
    ["-C", dir, "for-each-ref", "--format=%(refname)", `refs/heads/${name}`, `refs/remotes/*/${name}`],
    { allowFail: true, timeout: 5_000 },
  );
  return res.status === 0 && res.stdout.trim().length > 0;
}

/** Map checkout path -> Herdr Spaces and stray panes that live inside it. */
export function herdrPresence(paths) {
  let workspaces = [];
  let panes = [];
  try {
    workspaces = listWorkspaces();
    panes = listPanes();
  } catch {
    return new Map();
  }
  const byPath = new Map(paths.map((p) => [p, { spaces: [], panes: [] }]));
  // Longest path first so nested checkouts win.
  const ordered = [...paths].sort((a, b) => b.length - a.length);
  const owner = (dir) => ordered.find((p) => dir && isInside(dir, p));
  const spaceOwner = new Map();
  for (const ws of workspaces) {
    const p = owner(workspaceDir(ws, panes));
    if (p) {
      byPath.get(p).spaces.push(ws);
      spaceOwner.set(ws.workspace_id, p);
    }
  }
  for (const pane of panes) {
    const p = owner(pane.foreground_cwd || pane.cwd);
    // Panes inside a Space we already counted go with that Space.
    if (p && spaceOwner.get(pane.workspace_id) !== p) byPath.get(p).panes.push(pane);
  }
  return byPath;
}

export class Picker {
  constructor({ mode = "browse", screen = new Screen(), exit = (code) => process.exit(code) } = {}) {
    this.mode = mode;
    this.screen = screen;
    this.exitFn = exit;
    this.ctx = invocationContext();
    this.config = loadConfig();
    this.selected = 0;
    this.filter = "";
    this.filtering = false;
    this.message = "";
    this.messageTone = "muted";
    this.overlay = null; // { type: "prompt" | "confirm" | "choose", ... }
    this.busy = false;
    this.loadingFull = false;
    this.list = null;
    this.presence = new Map();
    // `b` also lists local branches that have no worktree yet.
    this.showBranches = !!this.config.showBranches;
  }

  // ------------------------------------------------------------- lifecycle

  async start() {
    const repo = repoOf(this.ctx.cwd);
    this.screen.enter();
    this.screen.onKey = (keys) => this.onKeys(keys);
    process.stdout.on("resize", () => this.render());
    if (!repo) {
      return this.fatal(`Not inside a git repository (${tildify(this.ctx.cwd) || "no cwd"}). Focus a pane in a repo first.`);
    }
    this.repo = repo;
    try {
      this.applyList(wtList(repo.toplevel, { branches: this.showBranches }));
    } catch (error) {
      return this.fatal(`wt list failed: ${error.message}`);
    }
    this.refreshFull();

    if (this.mode === "create") this.promptCreate();
    else if (this.mode === "remove-current") {
      const item = this.itemForDir(this.ctx.cwd);
      if (!item) return this.fatal("This pane is not inside a worktree of this repo.");
      this.confirmRemove(item, { exitOnCancel: true });
    } else if (this.mode === "pr-link") {
      const ref = prRefFromUrl(this.ctx.clickedUrl);
      if (!ref) return this.fatal(`Not a pull request URL: ${this.ctx.clickedUrl}`);
      await this.switchAndOpen(ref, { create: false, target: "space" });
      return;
    }
    this.render();
  }

  fatal(text) {
    this.overlay = { type: "fatal", text, footer: " press any key to close" };
    this.render();
  }

  exit(code = 0) {
    this.screen.leave();
    this.exitFn(code);
  }

  // ------------------------------------------------------------- data

  applyList(list) {
    const prevBranch = this.rows()?.[this.selected]?.branch;
    this.list = list;
    this.primary = primaryOf(list);
    const items = worktreeItems(list);
    this.presence = herdrPresence(items.map((i) => canon(i.worktree.path)));
    const idx = this.rows().findIndex((i) => i.branch === prevBranch);
    if (idx >= 0) this.selected = idx;
    this.selected = Math.min(this.selected, Math.max(0, this.rows().length - 1));
  }

  async refreshFull() {
    this.loadingFull = true;
    this.render();
    try {
      this.applyList(await wtListAsync(this.repo.toplevel, { full: true, branches: this.showBranches }));
    } catch (error) {
      this.setMessage(`PR status unavailable (${fit(error.message, 60)})`, "warn");
    }
    this.loadingFull = false;
    this.render();
  }

  rows() {
    if (!this.list) return [];
    const q = this.filter.toLowerCase();
    const branchOnly = this.showBranches ? this.list.items.filter((i) => !i.worktree && i.branch) : [];
    return [...worktreeItems(this.list), ...branchOnly].filter(
      (i) =>
        !q ||
        (i.branch ?? "").toLowerCase().includes(q) ||
        (i.worktree?.path ?? "").toLowerCase().includes(q) ||
        String(i.pr?.number ?? "").includes(q),
    );
  }

  itemForDir(dir) {
    const items = worktreeItems(this.list).sort((a, b) => b.worktree.path.length - a.worktree.path.length);
    return items.find((i) => isInside(dir, i.worktree.path)) ?? null;
  }

  presenceOf(item) {
    if (!item.worktree) return { spaces: [], panes: [] };
    return this.presence.get(canon(item.worktree.path)) ?? { spaces: [], panes: [] };
  }

  setMessage(text, t = "muted") {
    this.message = text;
    this.messageTone = t;
  }

  // ------------------------------------------------------------- input

  onKeys(keys) {
    for (const key of keys) {
      if (key === "ctrl+c") return this.exit(130);
      if (this.busy) continue;
      if (this.overlay) this.onOverlayKey(key);
      else if (this.filtering) this.onFilterKey(key);
      else this.onListKey(key);
    }
    this.render();
  }

  onFilterKey(key) {
    if (key === "esc") {
      this.filtering = false;
      this.filter = "";
    } else if (key === "enter" || key === "down" || key === "up") {
      this.filtering = false;
      if (key !== "enter") this.onListKey(key);
    } else if (key === "backspace") this.filter = this.filter.slice(0, -1);
    else if (key === "ctrl+u") this.filter = "";
    else if (key.length === 1) this.filter += key;
    this.selected = 0;
  }

  onListKey(key) {
    const rows = this.rows();
    const item = rows[this.selected];
    const page = Math.max(1, this.listHeight() - 1);
    switch (key) {
      case "q":
      case "esc":
        if (this.filter) {
          this.filter = "";
          this.selected = 0;
        } else this.exit(0);
        return;
      case "up":
      case "k":
        this.selected = Math.max(0, this.selected - 1);
        return;
      case "down":
      case "j":
        this.selected = Math.min(rows.length - 1, this.selected + 1);
        return;
      case "pageup":
        this.selected = Math.max(0, this.selected - page);
        return;
      case "pagedown":
        this.selected = Math.min(rows.length - 1, this.selected + page);
        return;
      case "home":
      case "g":
        this.selected = 0;
        return;
      case "end":
      case "G":
        this.selected = Math.max(0, rows.length - 1);
        return;
      case "/":
        this.filtering = true;
        return;
      case "n":
      case "c":
        this.promptCreate();
        return;
      case "p":
        this.promptCreate({ pr: true });
        return;
      case "r":
        this.setMessage("Refreshing…");
        try {
          this.applyList(wtList(this.repo.toplevel, { branches: this.showBranches }));
        } catch (error) {
          this.setMessage(error.message, "bad");
        }
        this.refreshFull().then(() => this.setMessage(""));
        return;
      case "b":
        this.showBranches = !this.showBranches;
        this.setMessage(this.showBranches ? "Showing branches without a worktree" : "");
        try {
          this.applyList(wtList(this.repo.toplevel, { branches: this.showBranches }));
        } catch (error) {
          this.setMessage(error.message, "bad");
        }
        this.refreshFull();
        return;
      case "x":
      case "d":
      case "delete":
        if (item && !item.worktree) this.setMessage("No worktree to remove for this branch", "warn");
        else if (item) this.confirmRemove(item);
        return;
      case "o":
        if (item?.pr?.url) this.openUrl(item.pr.url);
        else this.setMessage("No open PR for this branch", "warn");
        return;
      default:
        if (item && Object.hasOwn(TARGET_KEYS, key)) {
          this.openItem(item, TARGET_KEYS[key] ?? this.config.defaultOpen);
        }
    }
  }

  onOverlayKey(key) {
    const o = this.overlay;
    if (o.type === "fatal") return this.exit(1);
    if (o.type === "prompt") {
      if (key === "esc") return o.onCancel();
      if (key === "enter") return o.onSubmit(o.value.trim());
      if (key === "backspace") o.value = o.value.slice(0, -1);
      else if (key === "ctrl+u") o.value = "";
      else if (key.length === 1) o.value += key;
      return;
    }
    if (o.type === "choose" || o.type === "confirm") {
      if (key === "esc" || key === "q") return o.onCancel();
      const handler = o.keys[key];
      if (handler) handler();
    }
  }

  // ------------------------------------------------------------- actions

  async openItem(item, target) {
    // A branch without a worktree: let wt create the checkout, then open it.
    if (!item.worktree) return this.switchAndOpen(item.branch, { create: false, target });
    const label = item.branch ?? basename(item.worktree.path);
    const path = item.worktree.path;
    try {
      this.doOpen({ path, label, target });
      this.exit(0);
    } catch (error) {
      this.setMessage(`Could not open: ${error.message}`, "bad");
    }
  }

  doOpen({ path, label, target }) {
    const primaryPath = this.primary?.worktree.path ?? this.repo.toplevel;
    if (target === "tab") return openAsTab({ workspaceId: this.ctx.workspaceId, path, label });
    if (target === "split" || target === "split-down") {
      return openAsSplit({ paneId: this.ctx.paneId, path, label, direction: target === "split" ? "right" : "down" });
    }
    return openAsSpace({ primaryPath, path, label });
  }

  promptCreate({ pr = false } = {}) {
    const exitOnCancel = this.mode === "create";
    const cancel = () => (exitOnCancel ? this.exit(0) : (this.overlay = null));
    this.overlay = {
      type: "prompt",
      title: pr ? "Check out a pull request" : "New worktree",
      label: pr ? "PR number or URL" : "Branch",
      hint: pr
        ? "e.g. 123 or https://github.com/org/repo/pull/123"
        : "new name creates a branch · existing or pr:123 checks it out",
      value: "",
      onCancel: cancel,
      onSubmit: (raw) => {
        if (!raw) return;
        let target = raw;
        if (pr) target = /^\d+$/.test(raw) ? `pr:${raw}` : (prRefFromUrl(raw) ?? raw);
        const isRef = /^(pr|mr):\d+$/.test(target) || /^https?:\/\//.test(target);
        const exists = isRef || branchExists(this.repo.toplevel, target);
        if (exists) return this.chooseTarget({ target, create: false, onCancel: cancel });
        this.overlay = {
          type: "prompt",
          title: `New branch ${target}`,
          label: "Base",
          hint: `Enter for ${this.list.defaultBranch ?? "the default branch"} · @ = current HEAD · any branch or pr:N`,
          value: "",
          onCancel: cancel,
          onSubmit: (base) => this.chooseTarget({ target, create: true, base: base || undefined, onCancel: cancel }),
        };
      },
    };
  }

  chooseTarget({ target, create, base, onCancel }) {
    const go = (t) => this.switchAndOpen(target, { create, base, target: t });
    const after = this.config.afterCreate;
    if (after && after !== "ask") return go(after);
    this.overlay = {
      type: "choose",
      title: `${create ? "Create" : "Open"} ${target}${base ? ` from ${base}` : ""}`,
      lines: [
        `${style.bold("enter")} new Space   ${style.bold("t")} tab here   ${style.bold("v")} split right   ${style.bold("-")} split below   ${style.bold("n")} create only`,
      ],
      onCancel,
      keys: {
        enter: () => go("space"),
        s: () => go("space"),
        t: () => go("tab"),
        v: () => go("split"),
        "-": () => go("split-down"),
        n: () => go("none"),
      },
    };
  }

  /** Run `wt switch` with the terminal handed over, then open the result. */
  async switchAndOpen(ref, { create, base, target }) {
    this.busy = true;
    this.overlay = null;
    this.screen.leave();
    this.screen.out.write(
      `\x1b[2J\x1b[H\n  ${style.bold("wt switch")} ${create ? "--create " : ""}${ref}${base ? ` --base ${base}` : ""}\n\n`,
    );
    let result;
    try {
      result = await wtSwitch(this.repo.toplevel, ref, { create, base });
    } catch (error) {
      this.screen.out.write(`\n  ${tone.bad(error.message)}\n  Press any key to go back.`);
      await waitKey();
      this.busy = false;
      if (this.mode !== "browse") return this.exit(1);
      this.screen.enter();
      this.render();
      return;
    }
    const label = result.branch ?? ref;
    try {
      if (target !== "none") this.doOpen({ path: result.path, label, target });
      herdrQuiet(["plugin", "action", "invoke", `${process.env.HERDR_PLUGIN_ID}.refresh`]);
      if (target === "none") notify(`Worktree ready: ${label}`, tildify(result.path));
    } catch (error) {
      notify(`Worktree ${label} created, opening failed`, error.message);
    }
    this.busy = false;
    this.exit(0);
  }

  confirmRemove(item, { exitOnCancel = false } = {}) {
    const cancel = () => (exitOnCancel ? this.exit(0) : (this.overlay = null));
    if (item.worktree.main) {
      this.setMessage("The primary worktree can't be removed here.", "warn");
      if (exitOnCancel) return this.fatal("The primary worktree can't be removed here.");
      return;
    }
    const flags = { force: false, forceDelete: false, keepBranch: false, closePanes: this.config.closePanesOnRemove };
    const dirty = isDirty(item);
    const presence = this.presenceOf(item);
    const label = item.branch ?? basename(item.worktree.path);
    const build = () => {
      const box = (on) => (on ? tone.accent("[x]") : "[ ]");
      const lines = [
        `${style.bold(label)}  ${tone[describe(item).tone](describe(item).text)}`,
        style.dim(tildify(item.worktree.path)),
        "",
      ];
      if (dirty) lines.push(tone.warn("Uncommitted changes. wt refuses unless you force (it saves a backup ref first)."));
      if (presence.spaces.length || presence.panes.length) {
        const names = [
          ...presence.spaces.map((w) => `Space "${w.label}"`),
          ...presence.panes.map((p) => `pane ${p.pane_id}`),
        ];
        lines.push(`Open in Herdr: ${fit(names.join(", "), this.screen.cols - 20)}`);
      }
      lines.push(
        "",
        `${box(flags.force)} ${style.bold("f")} force: discard uncommitted changes`,
        `${box(flags.forceDelete)} ${style.bold("D")} delete the branch even if unmerged`,
        `${box(flags.keepBranch)} ${style.bold("k")} keep the branch`,
        `${box(flags.closePanes)} ${style.bold("c")} close its Herdr Spaces and panes`,
      );
      return lines;
    };
    const toggle = (name) => () => {
      flags[name] = !flags[name];
      if (name === "keepBranch" && flags.keepBranch) flags.forceDelete = false;
      if (name === "forceDelete" && flags.forceDelete) flags.keepBranch = false;
      this.overlay.lines = build();
    };
    this.overlay = {
      type: "confirm",
      title: "Remove worktree",
      footer: " y remove · f D k c toggle · esc cancel",
      lines: build(),
      onCancel: cancel,
      keys: {
        f: toggle("force"),
        D: toggle("forceDelete"),
        k: toggle("keepBranch"),
        c: toggle("closePanes"),
        y: () => this.doRemove(item, flags, presence, { exitAfter: exitOnCancel }),
      },
    };
  }

  async doRemove(item, flags, presence, { exitAfter }) {
    const label = item.branch ?? item.worktree.path;
    this.busy = true;
    this.overlay = null;
    this.screen.leave();
    this.screen.out.write(`\x1b[2J\x1b[H\n  ${style.bold("wt remove")} ${label}\n\n`);
    let result;
    try {
      // Target by path so detached checkouts work too; run from the primary worktree.
      const from = this.primary?.worktree.path ?? this.repo.toplevel;
      result = await wtRemove(from, item.branch ?? item.worktree.path, flags);
    } catch (error) {
      this.screen.out.write(`\n  ${tone.bad(error.message)}\n  Press any key to go back.`);
      await waitKey();
      this.busy = false;
      if (exitAfter) return this.exit(1);
      this.screen.enter();
      this.render();
      return;
    }
    // Only close Herdr things after the checkout is really gone.
    if (flags.closePanes) {
      for (const pane of presence.panes) herdrQuiet(["pane", "close", pane.pane_id]);
      for (const ws of presence.spaces) herdrQuiet(["workspace", "close", ws.workspace_id]);
    }
    const outcome = {
      deleted: "branch deleted",
      deferred: "branch cleanup in background",
      not_attempted: "branch kept",
      retained_unmerged: "branch kept (unmerged)",
      retained_checked_out: "branch kept (checked out elsewhere)",
    }[result.branch_outcome] ?? "";
    notify(`Removed worktree ${label}`, outcome);
    herdrQuiet(["plugin", "action", "invoke", `${process.env.HERDR_PLUGIN_ID}.refresh`]);
    this.busy = false;
    if (exitAfter) return this.exit(0);
    this.screen.enter();
    try {
      this.applyList(wtList(this.repo.toplevel));
    } catch {
      /* keep the old list */
    }
    this.setMessage(`Removed ${label}${outcome ? `, ${outcome}` : ""}`, "good");
    this.render();
    this.refreshFull();
  }

  openUrl(url) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    const res = run(opener, [url], { allowFail: true, timeout: 5_000 });
    this.setMessage(res.status === 0 ? `Opened ${url}` : url, res.status === 0 ? "muted" : "warn");
  }

  // ------------------------------------------------------------- render

  listHeight() {
    return Math.max(3, this.screen.rows - 6);
  }

  render() {
    if (!this.screen.active) return;
    const W = this.screen.cols;
    const lines = [];
    const repoName = this.primary ? basename(this.primary.worktree.path) : basename(this.repo?.toplevel ?? "");
    const right = this.loadingFull ? tone.busy(`${icons().loading} fetching PR status`) : "";
    const title = `${tone.muted("╭─")} ${style.bold("Worktrees")} ${tone.muted("·")} ${tone.path(repoName)}`;
    lines.push(title + " ".repeat(Math.max(1, W - width(title) - width(right) - 1)) + right);

    if (this.filtering || this.filter) lines.push(` ${tone.accent("/")} ${this.filter}${this.filtering ? "▏" : ""}`);
    else lines.push("");

    if (this.overlay && this.overlay.type !== "prompt") {
      lines.push(...this.renderOverlay(W));
    } else {
      lines.push(...this.renderRows(W));
    }

    // Bottom: prompt or message, then key help.
    while (lines.length < this.screen.rows - 2) lines.push("");
    lines.length = Math.min(lines.length, this.screen.rows - 2);
    if (this.overlay?.type === "prompt") {
      const o = this.overlay;
      lines[lines.length - 1] = ` ${style.dim(o.title + " ·")} ${style.dim(o.hint)}`;
      lines.push(` ${style.bold(o.label + ":")} ${o.value}▏`);
      lines.push(` ${style.dim("enter confirm · esc cancel · ctrl+u clear")}`);
    } else {
      lines.push(this.message ? ` ${tone[this.messageTone]?.(fit(this.message, W - 2)) ?? this.message}` : "");
      const help = this.overlay
        ? (this.overlay.footer ?? " esc cancel")
        : ` enter open · t tab · v split · - below · n new · p PR · b ${this.showBranches ? "hide" : "show"} branches · x remove · o PR web · r refresh · / filter · q quit`;
      lines.push(`${tone.muted("╰─")}${tone.good("❯")}${tone.muted(fit(help, W - 3))}`);
    }
    this.screen.draw(lines);
  }

  renderRows(W) {
    const rows = this.rows();
    const h = this.listHeight();
    if (!rows.length) return [style.dim(this.filter ? "  no match" : "  no worktrees")];
    const start = Math.max(0, Math.min(this.selected - Math.floor(h / 2), rows.length - h));
    const I = icons();
    const branchW = Math.min(36, Math.max(12, ...rows.map((i) => width(i.branch ?? "") + width(lead(I.branch))))) + 1;
    const statusW = Math.min(30, Math.max(10, Math.floor(W * 0.3)));
    const herdrW = 14;
    const cwd = canon(this.ctx.cwd);
    const out = [];
    for (let n = start; n < Math.min(rows.length, start + h); n++) {
      const item = rows[n];
      const sel = n === this.selected;
      const d = describe(item);
      const pres = this.presenceOf(item);
      const gutter = !item.worktree
        ? I.branchOnly
        : item.worktree.main
          ? I.primary
          : isInside(cwd, item.worktree.path)
            ? I.current
            : I.other;
      const open = pres.spaces.length
        ? `${I.space} ${pres.spaces[0].label}`
        : pres.panes.length
          ? `${I.panes} ${pres.panes.length} pane${pres.panes.length > 1 ? "s" : ""}`
          : "";
      const branch = item.branch
        ? `${lead(I.branch)}${item.branch}`
        : `${lead(I.detached)}${item.head?.short_sha ?? "detached"}`;
      const pathW = Math.max(0, W - 4 - branchW - statusW - herdrW - 3);
      let line =
        `${sel ? tone.accent("▌") : " "}${sel ? gutter : style.dim(gutter)} ` +
        `${tone.branch(sel ? style.bold(pad(branch, branchW)) : pad(branch, branchW))} ` +
        `${tone[d.tone](pad(d.text, statusW))} ` +
        `${tone.info(pad(open, herdrW))} ` +
        (item.worktree ? tone.path(fit(tildify(item.worktree.path), pathW)) : tone.muted(fit("no worktree yet", pathW)));
      if (sel) line = `\x1b[48;5;236m${line}`;
      out.push(line);
    }
    return out;
  }

  renderOverlay(W) {
    const o = this.overlay;
    if (o.type === "fatal") return ["", ` ${tone.bad(o.text)}`];
    const out = ["", ` ${style.bold(o.title)}`, ""];
    for (const l of o.lines) out.push(`   ${l}`);
    return out.map((l) => (width(l) > W ? fit(l.replace(/\x1b\[[0-9;]*m/g, ""), W) : l));
  }
}

function waitKey() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.once("data", () => {
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      resolve();
    });
  });
}
