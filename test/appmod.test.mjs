// The app mod runs inside the Herdr app. These tests load it against stand-ins
// for gpui-kit / gpui-base / herdr, and cover the pure helpers plus list wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

const STUBS = {
  "gpui-kit": `
    const el = () => new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "when") return (cond, fn) => (cond ? fn(el()) : el());
        if (prop === "children") return (items) => { for (const i of items) void i; return el(); };
        if (prop === "then") return undefined;
        return () => el();
      },
      apply() { return el(); },
    });
    export const div = () => el();
    export class View {}
    export { el };
  `,
  "gpui-base": `
    import { el } from "gpui-kit";
    export const v_flex = () => el();
    export const h_flex = () => el();
    export const Input = { new: () => el() };
    export const InputState = { new: (o = {}) => {
      let value = o.value ?? "";
      const handlers = {};
      return { on(name, fn) { handlers[name] = fn; }, value: () => value, set: (v) => { value = v; handlers.change?.({}, globalThis.__wt.cx); }, focus() {} };
    } };
  `,
  herdr: `
    const wt = () => globalThis.__wt;
    export const exec = async (cmd, args, opts) => {
      wt().execCalls.push([cmd, ...args, opts]);
      if (cmd === "herdr") return wt().herdr(args);
      if (cmd === "node") return wt().node(args);
      if (cmd === "wt") return wt().wt(args);
      if (cmd === "git") return wt().git(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    export const run = (name, args) => { wt().runs.push([name, args]); return null; };
    export const home = () => "/home/u";
    export const theme = () => new Proxy({}, { get: () => "#000000" });
    export const props = () => ({ overlay: "ov1" });
    export const closeOverlay = (id) => { wt().closed.push(id); return null; };
    export const spaces = () => wt().spaces;
    export const panes = () => wt().panes;
  `,
};

async function loadMod() {
  const dir = mkdtempSync(join(tmpdir(), "wt-mod-"));
  const urls = {};
  for (const [name, code] of Object.entries(STUBS)) {
    const file = join(dir, `${name}.mjs`);
    writeFileSync(file, code.replace(/from "gpui-kit"/g, `from "${pathToFileURL(join(dir, "gpui-kit.mjs")).href}"`));
    urls[name] = pathToFileURL(file).href;
  }
  let main = readFileSync(join(ROOT, "app-mod", "main.js"), "utf8");
  for (const [name, url] of Object.entries(urls)) main = main.replaceAll(`from "${name}"`, `from "${url}"`);
  const file = join(dir, "main.mjs");
  writeFileSync(file, main);
  return import(pathToFileURL(file).href);
}

const LIST = {
  repo: { toplevel: "/home/u/code/app", commonDir: "/home/u/code/app/.git", defaultBranch: "main", forgeUrl: null },
  worktrees: [
    { branch: "main", path: "/home/u/code/app", main: true, current: true, dirty: false, kind: "clean", tone: "good", status: "✓ clean", pr: null },
    { branch: "feat", path: "/home/u/code/app.feat", main: false, current: false, dirty: true, kind: "dirty", tone: "warn", status: "● dirty !", pr: null },
  ],
};

function setup(overrides = {}) {
  const pending = [];
  const cx = {
    notify() {},
    spawn(fn) {
      const p = fn(cx);
      pending.push(p);
      return p;
    },
    timer: { after() {}, every() {} },
    focus_handle: () => ({ focus() {} }),
    stop_propagation() {},
  };
  const wt = {
    cx,
    execCalls: [],
    runs: [],
    closed: [],
    spaces: [{ id: "s1", active: true, machine: null, folder: "/home/u/code/app", name: "app", tabs: [{ id: "t1" }] }],
    panes: [{ id: "p1", tab: "t1", cwd: "/home/u/code/app" }],
    plugins: [{ plugin_id: "maumercado.worktrunk", plugin_root: "/repo" }],
    herdr(args) {
      if (args.join(" ") !== "plugin list --json") return { code: 1, stdout: "", stderr: "unexpected" };
      return { code: 0, stdout: JSON.stringify({ result: { plugins: this.plugins } }), stderr: "" };
    },
    node(args) {
      if (args[0]?.endsWith("main.mjs") && args[1] === "list" && args[2] === "--json") {
        return { code: 0, stdout: JSON.stringify(LIST), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected node" };
    },
    wt() {
      return { code: 0, stdout: JSON.stringify({ path: "/home/u/code/app.new", branch: "new" }), stderr: "" };
    },
    git() {
      return { code: 0, stdout: "", stderr: "" };
    },
    ...overrides,
  };
  globalThis.__wt = wt;
  return { wt, cx, settle: async () => { while (pending.length) await pending.shift(); } };
}

test("pure helpers: cli path, create target, switch/remove args, presence", async () => {
  const mod = await loadMod();
  assert.equal(
    mod.cliFromPluginList(JSON.stringify({ result: { plugins: [{ plugin_id: "other", plugin_root: "/x" }, { plugin_id: "maumercado.worktrunk", plugin_root: "/p/1" }] } })),
    "/p/1/src/main.mjs",
  );
  assert.equal(mod.cliFromPluginList("not json"), null);
  assert.equal(mod.createTarget("42"), "pr:42");
  assert.equal(mod.createTarget("https://github.com/a/b/pull/9/files"), "pr:9");
  assert.equal(mod.createTarget("feat/login"), "feat/login");
  assert.deepEqual(mod.switchArgs("/r", "feat", { create: true, base: "main" }), [
    "-C", "/r", "switch", "--no-cd", "--format=json", "--create", "--base", "main", "feat",
  ]);
  assert.deepEqual(mod.removeArgs("/r", "feat", { force: true, keepBranch: true }), [
    "-C", "/r", "remove", "--foreground", "--force", "--no-delete-branch", "feat",
  ]);
  assert.equal(mod.pathInside("/a/b/c", "/a/b"), true);
  assert.equal(mod.pathInside("/a/other", "/a/b"), false);
  assert.equal(mod.tildify("/home/u/code/app", "/home/u"), "~/code/app");
  assert.deepEqual(mod.parseSwitchResult('noise\n{"path":"/x","branch":"b"}\n'), { path: "/x", branch: "b" });

  const spaces = [
    { id: "s1", machine: null, name: "feat", tabs: [{ id: "t1" }] },
    { id: "s2", machine: null, name: "other", tabs: [{ id: "t2" }] },
  ];
  const panes = [
    { id: "p1", tab: "t1", cwd: "/home/u/code/app.feat" },
    { id: "p2", tab: "t2", cwd: "/home/u/code/other" },
  ];
  const pres = mod.presenceIn("/home/u/code/app.feat", spaces, panes, null);
  assert.deepEqual(pres.spaces.map((s) => s.id), ["s1"]);
});

test("loads worktrees through list --json and draws the list", async () => {
  const mod = await loadMod();
  const { wt, cx, settle } = setup();
  const view = new mod.default();
  view.init({}, cx);
  await settle();
  assert.equal(view.cli, "/repo/src/main.mjs");
  assert.deepEqual(view.rows.map((w) => w.branch), ["main", "feat"]);
  assert.ok(wt.execCalls.some((c) => c[0] === "node" && c.includes("list") && c.includes("--json")));
  view.render();
  view.openAs("space");
  assert.ok(wt.runs.some(([name]) => name === "space.select" || name === "space.new"));
  assert.deepEqual(wt.closed, ["ov1"]);
});

test("missing plugin shows install hint", async () => {
  const mod = await loadMod();
  const { cx, settle } = setup({ plugins: [] });
  const view = new mod.default();
  view.init({}, cx);
  await settle();
  assert.match(view.error, /herdr plugin install maumercado\/herdr-worktrunk/);
  view.render();
});

test("create via wt switch then opens a space", async () => {
  const mod = await loadMod();
  const { wt, cx, settle } = setup();
  const view = new mod.default();
  view.init({}, cx);
  await settle();
  view.form = { create: true, target: "new", base: "main" };
  await view.doCreate("space", cx);
  assert.ok(wt.execCalls.some((c) => c[0] === "wt" && c.includes("switch") && c.includes("--create")));
  assert.ok(wt.runs.some(([name, args]) => name === "space.new" && args.folder === "/home/u/code/app.new"));
});

test("remove closes spaces then opens a terminal with wt remove", async () => {
  const mod = await loadMod();
  const { wt, cx, settle } = setup({
    spaces: [
      { id: "s1", active: true, machine: null, folder: "/home/u/code/app", name: "app", tabs: [{ id: "t1" }] },
      { id: "s2", active: false, machine: null, folder: "/home/u/code/app.feat", name: "feat", tabs: [{ id: "t2" }] },
    ],
    panes: [
      { id: "p1", tab: "t1", cwd: "/home/u/code/app" },
      { id: "p2", tab: "t2", cwd: "/home/u/code/app.feat" },
    ],
  });
  const view = new mod.default();
  view.init({}, cx);
  await settle();
  view.selected = 1;
  view.openRemove(cx);
  assert.equal(view.mode, "remove");
  view.confirmRemove();
  assert.ok(wt.runs.some(([name, args]) => name === "space.close" && args.id === "s2"));
  assert.ok(wt.runs.some(([name, args]) => name === "terminal.open" && args.argv.includes("remove")));
});

test("exec passes on: machine for remote spaces", async () => {
  const mod = await loadMod();
  const { wt, cx, settle } = setup({
    spaces: [{ id: "s1", active: true, machine: "box", folder: "/home/u/code/app", name: "app", tabs: [{ id: "t1" }] }],
  });
  const view = new mod.default();
  view.init({}, cx);
  await settle();
  const listCall = wt.execCalls.find((c) => c[0] === "node" && c.includes("list"));
  assert.ok(listCall);
  const opts = listCall[listCall.length - 1];
  assert.equal(opts.on, "box");
});
