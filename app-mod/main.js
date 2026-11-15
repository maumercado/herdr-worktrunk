// Worktrees: list, open, create and remove git worktrees through Worktrunk (wt).
// A front end for the herdr-worktrunk CLI. Opened as a dialog: `mod.open worktrunk`
// (cmd-shift-a in the user's Herdr app keys, the palette, or another mod).
//
// Reads `node src/main.mjs list --json` from the linked plugin so Worktrunk
// logic stays in one place. Create runs `wt switch` via exec; remove runs
// `wt remove` in a terminal so Worktrunk's prompts stay interactive.
//
// The CLI path comes from `herdr plugin list --json` (plugin_root).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, run, theme, props, closeOverlay, spaces, panes, home } from "herdr";

const PLUGIN_ID = "maumercado.worktrunk";
const INSTALL = "herdr plugin install maumercado/herdr-worktrunk";

// Shows the command's own output and waits, so prompts stay readable.
const WRAP = '"$0" "$@"; code=$?; printf "\\nPress Enter to close. "; read _; exit $code';

const TONE = { good: "done", warn: "working", bad: "blocked", muted: "dim", busy: "working" };

/** src/main.mjs inside the installed (or linked) plugin, from `herdr plugin list --json`. */
export function cliFromPluginList(stdout) {
  try {
    const data = JSON.parse(stdout);
    const plugins = data?.result?.plugins ?? data?.plugins ?? [];
    const plugin = plugins.find((p) => p.plugin_id === PLUGIN_ID);
    return plugin?.plugin_root ? `${plugin.plugin_root}/src/main.mjs` : null;
  } catch {
    return null;
  }
}

/** Where a space is now: its first terminal's live folder, else where it was made. */
export function spaceFolder(space, paneList = panes()) {
  if (!space) return null;
  const tabs = new Set((space.tabs ?? []).map((t) => t.id));
  return paneList.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder || null;
}

/** Home as ~ for display. */
export function tildify(path, userHome = home()) {
  if (!path || !userHome) return path ?? "";
  const [p, h] = [path, userHome].map((s) => s.replace(/\\/g, "/"));
  return p.startsWith(h) ? `~${p.slice(h.length)}` : path;
}

/** Parse a PR number or GitHub PR URL into `pr:N`, or return the raw branch. */
export function createTarget(raw) {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (/^\d+$/.test(s)) return `pr:${s}`;
  const m = /\/pull\/(\d+)/.exec(s);
  if (m) return `pr:${m[1]}`;
  return s;
}

/** CLI args for `wt switch --no-cd --format=json`. */
export function switchArgs(dir, target, { create = false, base } = {}) {
  const args = ["-C", dir, "switch", "--no-cd", "--format=json"];
  if (create) args.push("--create");
  if (base) args.push("--base", base);
  args.push(target);
  return args;
}

/** CLI args for `wt remove --foreground`. */
export function removeArgs(dir, target, { force = false, forceDelete = false, keepBranch = false } = {}) {
  const args = ["-C", dir, "remove", "--foreground"];
  if (force) args.push("--force");
  if (forceDelete) args.push("--force-delete");
  if (keepBranch) args.push("--no-delete-branch");
  args.push(target);
  return args;
}

/** Path is inside dir (or equal). */
export function pathInside(path, dir) {
  if (!path || !dir) return false;
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const d = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  return p === d || p.startsWith(d + "/");
}

/**
 * Spaces (and stray panes) whose live folder sits inside a checkout.
 * Deepest checkout wins when several nest.
 */
export function presenceIn(path, spaceList, paneList, machine) {
  const on = machine ?? null;
  const spacesHere = [];
  const panesHere = [];
  const spaceOwner = new Set();
  for (const s of spaceList) {
    if ((s.machine ?? null) !== on) continue;
    const at = spaceFolder(s, paneList);
    if (at && pathInside(at, path)) {
      spacesHere.push(s);
      spaceOwner.add(s.id);
    }
  }
  for (const p of paneList) {
    const space = spaceList.find((s) => (s.tabs ?? []).some((t) => t.id === p.tab));
    if (!space || (space.machine ?? null) !== on) continue;
    if (spaceOwner.has(space.id)) continue;
    if (p.cwd && pathInside(p.cwd, path)) panesHere.push(p);
  }
  return { spaces: spacesHere, panes: panesHere };
}

/** Last JSON object on stdout from `wt switch --format=json`. */
export function parseSwitchResult(stdout) {
  const lines = (stdout ?? "").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed?.path) return parsed;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export default class Worktrees extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.cli = null;
    this.error = null;
    this.repo = null;
    this.rows = null;
    this.selected = 0;
    this.mode = "list"; // list | create | remove | open-as
    this.form = null;
    this.remove = null;
    this.busy = false;
    this.message = "";
    this.folder = null;
    this.machine = null;
    this.filter = "";
    this.filterState = null;
    cx.spawn(async (cx) => {
      await this.boot(cx);
      cx.notify();
    });
  }

  focusedSpace() {
    return spaces().find((s) => s.active) ?? spaces()[0] ?? null;
  }

  async boot(cx) {
    const space = this.focusedSpace();
    this.machine = space?.machine ?? null;
    this.folder = spaceFolder(space) || home();
    this.cli = await this.findCli();
    if (!this.cli) {
      this.error = `The herdr-worktrunk plugin isn't installed. Run this in a terminal, then reopen: ${INSTALL}`;
      return;
    }
    await this.load();
  }

  async findCli() {
    const r = await exec("herdr", ["plugin", "list", "--json"], { timeout: 15000 }).catch(() => null);
    if (!r || r.code !== 0) return null;
    return cliFromPluginList(r.stdout);
  }

  /** Runs on the space's machine so remote checkouts see their own wt. */
  onOpts(extra = {}) {
    return this.machine != null ? { on: this.machine, ...extra } : { ...extra };
  }

  async load() {
    if (!this.cli) return;
    const r = await exec("node", [this.cli, "list", "--json", this.folder], this.onOpts({ timeout: 60000 })).catch((e) => ({
      code: 1,
      stdout: "",
      stderr: String(e),
    }));
    let data = null;
    try {
      data = JSON.parse(r.stdout);
    } catch {
      data = null;
    }
    if (!data || data.error || !data.worktrees) {
      this.error = data?.error ?? (r.stderr.trim() || "worktrunk list --json failed");
      this.rows = null;
      this.repo = null;
      return;
    }
    const keep = this.current()?.path;
    this.repo = data.repo;
    this.rows = data.worktrees;
    this.error = null;
    const index = keep ? this.rows.findIndex((w) => w.path === keep) : -1;
    if (index >= 0) this.selected = index;
    this.selected = Math.max(0, Math.min(this.selected, Math.max(0, this.rows.length - 1)));
  }

  current() {
    return this.shown()[this.selected];
  }

  shown() {
    const q = this.filter.trim().toLowerCase();
    if (!q || !this.rows) return this.rows ?? [];
    return this.rows.filter(
      (w) =>
        (w.branch ?? "").toLowerCase().includes(q) ||
        (w.path ?? "").toLowerCase().includes(q) ||
        String(w.pr ?? "").includes(q) ||
        (w.status ?? "").toLowerCase().includes(q),
    );
  }

  close() {
    closeOverlay(props().overlay);
  }

  back(cx) {
    this.mode = "list";
    this.form = null;
    this.remove = null;
    this.handle.focus();
    cx.notify();
  }

  // -------------------------------------------------------------------------
  // Open

  openAs(target) {
    const row = this.current();
    if (!row?.path) {
      this.message = "Select a worktree first";
      return;
    }
    const machine = this.machine ?? "";
    if (target === "tab") run("tab.new", { folder: row.path });
    else if (target === "split") run("pane.split", { direction: "right", folder: row.path });
    else if (target === "split-down") run("pane.split", { direction: "down", folder: row.path });
    else {
      const existing = presenceIn(row.path, spaces(), panes(), this.machine).spaces[0];
      if (existing) run("space.select", { id: existing.id });
      else run("space.new", { folder: row.path, machine });
    }
    this.close();
  }

  // -------------------------------------------------------------------------
  // Create

  openCreate(cx, { pr = false } = {}) {
    const state = InputState.new({ value: "", placeholder: pr ? "123 or PR URL" : "branch, or pr:123" });
    const form = {
      step: "target",
      pr,
      create: false,
      target: "",
      base: "",
      fields: [{ id: "target", label: pr ? "PR" : "Branch", value: "", state }],
      error: "",
    };
    state.on("change", (_e, cx) => {
      form.fields[0].value = state.value();
      form.error = "";
      cx.notify();
    });
    state.on("submit", (_e, cx) => this.submitCreate(cx));
    this.form = form;
    this.mode = "create";
    state.focus();
    cx.timer.after(200, () => state.focus());
    cx.notify();
  }

  submitCreate(cx) {
    const f = this.form;
    if (f.step === "target") {
      const raw = f.fields[0].value.trim();
      if (!raw) {
        f.error = f.pr ? "Type a PR number or URL" : "Type a branch name";
        cx.notify();
        return;
      }
      const target = createTarget(raw);
      if (f.pr && !/^pr:\d+$/.test(target)) {
        f.error = "Need a PR number or a github.com/.../pull/N URL";
        cx.notify();
        return;
      }
      f.target = target;
      const isRef = /^pr:\d+$/.test(target) || /^https?:\/\//.test(target);
      if (isRef || f.pr) {
        f.create = false;
        this.mode = "open-as";
        this.handle.focus();
        cx.notify();
        return;
      }
      // Existing branch → open; new name → ask for base then create.
      cx.spawn(async (cx) => {
        const dir = this.repo?.toplevel ?? this.folder;
        const exists = await this.branchExists(dir, target);
        if (exists) {
          f.create = false;
          this.mode = "open-as";
          this.handle.focus();
          cx.notify();
          return;
        }
        f.step = "base";
        const state = InputState.new({
          value: "",
          placeholder: this.repo?.defaultBranch ? `Enter for ${this.repo.defaultBranch}` : "default branch",
        });
        f.fields = [{ id: "base", label: "Base", value: "", state }];
        state.on("change", (_e, cx) => {
          f.fields[0].value = state.value();
          f.error = "";
          cx.notify();
        });
        state.on("submit", (_e, cx) => this.submitCreate(cx));
        state.focus();
        cx.timer.after(200, () => state.focus());
        cx.notify();
      });
      return;
    }
    if (f.step === "base") {
      f.base = f.fields[0].value.trim();
      f.create = true;
      this.mode = "open-as";
      this.handle.focus();
      cx.notify();
    }
  }

  async branchExists(dir, name) {
    const r = await exec(
      "git",
      ["-C", dir, "for-each-ref", "--format=%(refname)", `refs/heads/${name}`, `refs/remotes/*/${name}`],
      this.onOpts({ timeout: 10000 }),
    ).catch(() => null);
    return Boolean(r && r.code === 0 && r.stdout.trim());
  }

  /** After create (or open existing): pick Space / tab / split / create only. */
  async doCreate(target, cx) {
    const f = this.form;
    if (!f?.target || !this.repo) return;
    this.busy = true;
    this.message = `wt switch ${f.create ? "--create " : ""}${f.target}…`;
    this.mode = "list";
    cx.notify();
    const dir = this.repo.toplevel;
    const args = switchArgs(dir, f.target, { create: f.create, base: f.base || undefined });
    const r = await exec("wt", args, this.onOpts({ timeout: 600000 })).catch((e) => ({
      code: 1,
      stdout: "",
      stderr: String(e),
    }));
    this.busy = false;
    this.form = null;
    const result = parseSwitchResult(r.stdout);
    if (!result?.path) {
      this.message = (r.stderr || r.stdout || `wt switch failed (exit ${r.code})`).trim().split("\n").pop();
      await this.load();
      cx.notify();
      return;
    }
    if (target !== "none") {
      const machine = this.machine ?? "";
      if (target === "tab") run("tab.new", { folder: result.path });
      else if (target === "split") run("pane.split", { direction: "right", folder: result.path });
      else if (target === "split-down") run("pane.split", { direction: "down", folder: result.path });
      else run("space.new", { folder: result.path, machine });
      this.close();
      return;
    }
    this.message = `Ready: ${result.branch ?? f.target}`;
    await this.load();
    cx.notify();
  }

  // -------------------------------------------------------------------------
  // Remove

  openRemove(cx) {
    const row = this.current();
    if (!row) return;
    if (row.main) {
      this.message = "The primary worktree can't be removed here";
      cx.notify();
      return;
    }
    const presence = presenceIn(row.path, spaces(), panes(), this.machine);
    this.remove = {
      row,
      presence,
      force: !!row.dirty,
      forceDelete: false,
      keepBranch: false,
      closePanes: true,
    };
    this.mode = "remove";
    this.handle.focus();
    cx.notify();
  }

  /** Close matching spaces/panes, then run wt remove in a terminal. */
  confirmRemove() {
    const r = this.remove;
    if (!r) return;
    const dir = this.repo?.toplevel ?? this.folder;
    const target = r.row.branch || r.row.path;
    const args = removeArgs(dir, target, r);
    if (r.closePanes) {
      for (const p of r.presence.panes) run("pane.close", { pane: p.id });
      for (const s of r.presence.spaces) run("space.close", { id: s.id, confirmed: true });
    }
    const argv = ["sh", "-c", WRAP, "wt", ...args];
    const space = this.focusedSpace();
    if (this.machine != null) {
      run("space.new", { name: "Remove worktree", argv, folder: dir, machine: this.machine });
    } else if (!space || space.machine == null) {
      run("terminal.open", { argv, name: "Remove worktree", folder: dir });
    } else {
      run("space.new", { name: "Remove worktree", argv, folder: dir, machine: "" });
    }
    this.close();
  }

  // -------------------------------------------------------------------------
  // Keys

  key(e, cx) {
    if (e.key === "escape") {
      if (this.mode === "list") this.close();
      else this.back(cx);
      cx.stop_propagation();
      return;
    }
    if (this.mode === "open-as") {
      const map = { enter: "space", s: "space", t: "tab", v: "split", "-": "split-down", n: "none" };
      if (map[e.key]) {
        cx.spawn(async (cx) => this.doCreate(map[e.key], cx));
        cx.stop_propagation();
      }
      return;
    }
    if (this.mode === "remove") {
      const r = this.remove;
      if (e.key === "y" || e.key === "enter") {
        this.confirmRemove();
        cx.stop_propagation();
        return;
      }
      if (e.key === "f") r.force = !r.force;
      else if (e.key === "d") {
        r.forceDelete = !r.forceDelete;
        if (r.forceDelete) r.keepBranch = false;
      } else if (e.key === "k") {
        r.keepBranch = !r.keepBranch;
        if (r.keepBranch) r.forceDelete = false;
      } else if (e.key === "c") r.closePanes = !r.closePanes;
      else return;
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (this.mode !== "list" || !this.shown().length) return;
    const n = this.shown().length;
    if (e.key === "up") this.selected = Math.max(0, this.selected - 1);
    else if (e.key === "down") this.selected = Math.min(n - 1, this.selected + 1);
    else if (e.key === "enter" || e.key === "s") this.openAs("space");
    else if (e.key === "t") this.openAs("tab");
    else if (e.key === "v") this.openAs("split");
    else if (e.key === "-") this.openAs("split-down");
    else if (e.key === "n") this.openCreate(cx);
    else if (e.key === "p") this.openCreate(cx, { pr: true });
    else if (e.key === "x" || e.key === "delete") this.openRemove(cx);
    else if (e.key === "r") {
      cx.spawn(async (cx) => {
        this.message = "Refreshing…";
        cx.notify();
        await this.load();
        this.message = "";
        cx.notify();
      });
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  // -------------------------------------------------------------------------
  // Drawing

  button(t, id, label, onClick, primary = false, disabled = false) {
    return div()
      .id(id)
      .h(28)
      .px(12)
      .flex()
      .flex_none()
      .items_center()
      .rounded(7)
      .border_1()
      .border_color(primary ? t.solid : t.input)
      .bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground)
      .text_size(12)
      .font_medium()
      .when(disabled || this.busy, (el) => el.opacity(0.4))
      .when(!disabled && !this.busy, (el) =>
        el
          .cursor_pointer()
          .hover((s) => s.opacity(0.88))
          .on_click((_e, cx) => onClick(cx)),
      )
      .child(label);
  }

  check(t, on, label, key) {
    return h_flex()
      .id(`wt-check-${key}`)
      .gap(8)
      .items_center()
      .cursor_pointer()
      .on_click((_e, cx) => {
        this.remove[key] = !this.remove[key];
        if (key === "keepBranch" && this.remove.keepBranch) this.remove.forceDelete = false;
        if (key === "forceDelete" && this.remove.forceDelete) this.remove.keepBranch = false;
        cx.notify();
      })
      .child(div().text_size(13).text_color(on ? t.accent : t.dim).child(on ? "[x]" : "[ ]"))
      .child(div().text_size(12.5).text_color(t.foreground).child(label));
  }

  listBody(t) {
    const rows = this.shown();
    return v_flex()
      .flex_1()
      .min_h(0)
      .gap(6)
      .child(
        h_flex()
          .px(4)
          .text_size(11)
          .text_color(t.dim)
          .child(div().w(200).flex_none().child("BRANCH"))
          .child(div().w(160).flex_none().child("STATUS"))
          .child(div().flex_1().child("PATH")),
      )
      .child(
        v_flex()
          .id("wt-rows")
          .flex_1()
          .min_h(0)
          .overflow_y_scroll()
          .children(
            this.rows === null
              ? [div().px(4).py(8).text_size(12.5).text_color(t.dim).child("Reading worktrees…")]
              : rows.length === 0
                ? [div().px(4).py(8).text_size(12.5).text_color(t.dim).child(this.filter ? "No match" : "No worktrees")]
                : rows.map((w, i) => {
                    const on = i === this.selected;
                    const toneKey = TONE[w.tone] ?? "foreground";
                    const mark = w.main ? "^" : "";
                    return h_flex()
                      .id(`wt-row-${w.path}`)
                      .h(32)
                      .px(4)
                      .gap(8)
                      .items_center()
                      .rounded(7)
                      .cursor_pointer()
                      .when(on, (el) => el.bg(t.selected))
                      .hover((s) => s.bg(t.hover))
                      .on_click((_e, cx) => {
                        this.selected = i;
                        cx.notify();
                      })
                      .on_mouse_down("right", (_e, cx) => {
                        this.selected = i;
                        cx.notify();
                      })
                      .child(
                        div()
                          .w(200)
                          .flex_none()
                          .min_w(0)
                          .truncate()
                          .text_size(13)
                          .text_color(t.foreground)
                          .child(`${mark}${w.branch ?? "(detached)"}`),
                      )
                      .child(
                        div()
                          .w(160)
                          .flex_none()
                          .min_w(0)
                          .truncate()
                          .text_size(12)
                          .text_color(t[toneKey] ?? t.muted)
                          .child(w.status ?? ""),
                      )
                      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(tildify(w.path)));
                  }),
          ),
      );
  }

  createPane(t) {
    const f = this.form;
    const title = f.step === "base" ? `New branch ${f.target}` : f.pr ? "Check out a pull request" : "New worktree";
    const hint =
      f.step === "base"
        ? "Base branch, PR, or empty for the repo default. An existing branch name skips create."
        : f.pr
          ? "PR number or https://github.com/org/repo/pull/N"
          : "New name creates a branch · existing or pr:123 checks it out";
    return v_flex()
      .flex_1()
      .gap(10)
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child(title))
      .child(div().text_size(12).text_color(t.muted).child(hint))
      .children(
        f.fields.map((field) =>
          h_flex()
            .gap(10)
            .items_center()
            .child(div().w(64).flex_none().text_size(12.5).text_color(t.muted).child(field.label))
            .child(
              Input.new(field.state)
                .flex_1()
                .h(30)
                .px(8)
                .items_center()
                .rounded(7)
                .border_1()
                .border_color(t.input)
                .bg(t.background)
                .text_size(12.8)
                .text_color(t.foreground),
            ),
        ),
      )
      .when(Boolean(f.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(f.error)))
      .child(
        h_flex()
          .gap(8)
          .justify_end()
          .child(this.button(t, "wt-create-cancel", "Cancel", (cx) => this.back(cx)))
          .child(this.button(t, "wt-create-ok", "Next", (cx) => this.submitCreate(cx), true)),
      );
  }

  openAsPane(t) {
    const label = this.form?.target ?? "";
    return v_flex()
      .flex_1()
      .gap(10)
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child(`${this.form?.create ? "Create" : "Open"} ${label}`))
      .child(div().text_size(12.5).text_color(t.muted).child("Where should it open?"))
      .child(
        h_flex()
          .gap(6)
          .flex_wrap()
          .child(this.button(t, "wt-as-space", "Space", (cx) => cx.spawn(async (cx) => this.doCreate("space", cx)), true))
          .child(this.button(t, "wt-as-tab", "Tab", (cx) => cx.spawn(async (cx) => this.doCreate("tab", cx))))
          .child(this.button(t, "wt-as-split", "Split", (cx) => cx.spawn(async (cx) => this.doCreate("split", cx))))
          .child(this.button(t, "wt-as-down", "Split below", (cx) => cx.spawn(async (cx) => this.doCreate("split-down", cx))))
          .child(this.button(t, "wt-as-none", "Create only", (cx) => cx.spawn(async (cx) => this.doCreate("none", cx)))),
      )
      .child(h_flex().justify_end().child(this.button(t, "wt-as-cancel", "Cancel", (cx) => this.back(cx))));
  }

  removePane(t) {
    const r = this.remove;
    const row = r.row;
    const names = [
      ...r.presence.spaces.map((s) => `Space "${s.name}"`),
      ...r.presence.panes.map((p) => `pane ${p.id}`),
    ];
    return v_flex()
      .flex_1()
      .gap(8)
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child(`Remove ${row.branch ?? row.path}`))
      .child(div().text_size(12).text_color(t.dim).child(tildify(row.path)))
      .when(row.dirty, (el) =>
        el.child(div().text_size(12.5).text_color(t.working).child("Uncommitted changes. wt refuses unless you force (it saves a backup ref first).")),
      )
      .when(names.length > 0, (el) =>
        el.child(div().text_size(12.5).text_color(t.muted).child(`Open in Herdr: ${names.join(", ")}`)),
      )
      .child(this.check(t, r.force, "f  force: discard uncommitted changes", "force"))
      .child(this.check(t, r.forceDelete, "D  delete the branch even if unmerged", "forceDelete"))
      .child(this.check(t, r.keepBranch, "k  keep the branch", "keepBranch"))
      .child(this.check(t, r.closePanes, "c  close its Herdr Spaces and panes", "closePanes"))
      .child(
        h_flex()
          .gap(8)
          .justify_end()
          .child(this.button(t, "wt-rm-cancel", "Cancel", (cx) => this.back(cx)))
          .child(this.button(t, "wt-rm-ok", "Remove in a terminal", () => this.confirmRemove(), true)),
      );
  }

  render() {
    const t = theme();
    const repoName = this.repo?.toplevel ? this.repo.toplevel.replace(/\\/g, "/").split("/").pop() : "";
    let body;
    if (this.error) {
      body = div().flex_1().p(12).rounded(8).bg(t.blocked + "14").text_size(12.8).text_color(t.foreground).child(this.error);
    } else if (this.mode === "create" && this.form) body = this.createPane(t);
    else if (this.mode === "open-as" && this.form) body = this.openAsPane(t);
    else if (this.mode === "remove" && this.remove) body = this.removePane(t);
    else body = this.listBody(t);

    return v_flex()
      .id("worktrunk")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .min_h(0)
      .p(18)
      .gap(12)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(div().text_size(15).font_semibold().child("Worktrees"))
          .child(
            div()
              .flex_1()
              .text_size(12)
              .text_color(t.dim)
              .child(this.rows ? `${this.shown().length} in ${repoName}` : ""),
          )
          .when(!this.error && this.mode === "list", (el) =>
            el
              .child(this.button(t, "wt-open", "Open", () => this.openAs("space"), true, !this.current()))
              .child(this.button(t, "wt-tab", "Tab", () => this.openAs("tab"), false, !this.current()))
              .child(this.button(t, "wt-split", "Split", () => this.openAs("split"), false, !this.current()))
              .child(this.button(t, "wt-new", "New", (cx) => this.openCreate(cx)))
              .child(this.button(t, "wt-pr", "PR", (cx) => this.openCreate(cx, { pr: true })))
              .child(this.button(t, "wt-remove", "Remove", (cx) => this.openRemove(cx), false, !this.current() || this.current()?.main))
              .child(
                this.button(t, "wt-refresh", "Refresh", (cx) =>
                  cx.spawn(async (cx) => {
                    await this.load();
                    cx.notify();
                  }),
                ),
              ),
          )
          .child(div().text_size(11).text_color(t.dim).child("Esc")),
      )
      .child(body)
      .child(
        div()
          .text_size(11.5)
          .text_color(this.message ? t.muted : t.dim)
          .truncate()
          .child(
            this.message ||
              "enter/s Space · t tab · v split · - below · n new · p PR · x remove · r refresh",
          ),
      );
  }
}
