import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup, fakeScreen } from "./helpers.mjs";

// Picker modules read env lazily, so each test points process.env at a fresh fixture.
function withFixture() {
  const fx = setup();
  Object.assign(process.env, fx.env);
  return fx;
}

async function startPicker(fx, mode = "browse") {
  const { Picker } = await import("../src/picker.mjs");
  const screen = fakeScreen();
  let exitCode = null;
  const picker = new Picker({ mode, screen, exit: (c) => (exitCode = c) });
  await picker.start();
  await waitFor(() => !picker.loadingFull);
  picker.render();
  return { picker, screen, exited: () => exitCode };
}

const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const press = (picker, ...keys) => picker.onKeys(keys);
const select = (picker, branch) => {
  picker.selected = picker.rows().findIndex((i) => i.branch === branch);
  assert.ok(picker.selected >= 0, `${branch} listed`);
};
const type = (picker, text) => picker.onKeys([...text]);

test("lists worktrees with PR / dirty / merged status and Herdr presence", async () => {
  const fx = withFixture();
  const { screen } = await startPicker(fx);
  const text = screen.text();
  assert.match(text, /Worktrees · app/);
  assert.match(text, /\^ main\s+✓ clean/);
  assert.match(text, /feat-pr\s+#42 ✓ approved\s+◆ feat-pr/);
  assert.match(text, /feat-dirty\s+● dirty/);
  assert.match(text, /◆ dirty work/, "Space found via pane cwd");
  assert.match(text, /feat-merged\s+✓ merged, safe to remove/);
});

test("enter opens the selected worktree as a Space via `worktree open`", async () => {
  const fx = withFixture();
  const { picker, exited } = await startPicker(fx);
  fx.clearCalls();
  select(picker, "feat-merged");
  press(picker, "enter");
  const open = fx.calls().find((c) => c[0] === "worktree" && c[1] === "open");
  assert.deepEqual(open.slice(2), ["--cwd", fx.repo, "--path", fx.mergedPath, "--label", "feat-merged", "--focus"]);
  assert.equal(exited(), 0);
});

test("t opens a tab in the current Space, v a split next to the focused pane", async () => {
  const fx = withFixture();
  let { picker } = await startPicker(fx);
  fx.clearCalls();
  select(picker, "feat-pr");
  press(picker, "t");
  const tab = fx.calls().find((c) => c[0] === "tab");
  assert.ok(tab.includes("--workspace") && tab[tab.indexOf("--workspace") + 1] === "w1");
  assert.equal(tab[tab.indexOf("--cwd") + 1], fx.prPath);

  ({ picker } = await startPicker(fx));
  fx.clearCalls();
  select(picker, "feat-pr");
  press(picker, "v");
  const split = fx.calls().find((c) => c[1] === "split");
  assert.equal(split[split.indexOf("--pane") + 1], "w1:p1");
  assert.equal(split[split.indexOf("--direction") + 1], "right");
  assert.ok(fx.calls().some((c) => c[1] === "rename" && c.includes("feat-pr")));
});

test("filter narrows the list", async () => {
  const fx = withFixture();
  const { picker } = await startPicker(fx);
  press(picker, "/");
  type(picker, "dirt");
  assert.deepEqual(picker.rows().map((i) => i.branch), ["feat-dirty"]);
  press(picker, "esc");
  assert.equal(picker.rows().length, 4);
});

test("n creates a branch from a base with wt, then opens it as a Space", async () => {
  const fx = withFixture();
  const { picker, exited } = await startPicker(fx);
  fx.clearCalls();
  press(picker, "n");
  type(picker, "feat/new-thing");
  press(picker, "enter");
  assert.equal(picker.overlay.label, "Base", "new branch asks for a base");
  press(picker, "enter"); // default branch
  assert.equal(picker.overlay.type, "choose");
  press(picker, "enter"); // Space
  await waitFor(() => exited() !== null);
  const path = join(fx.root, "app.feat-new-thing");
  assert.ok(existsSync(path), "worktree created on disk");
  const open = fx.calls().find((c) => c[0] === "worktree" && c[1] === "open");
  assert.equal(open[open.indexOf("--path") + 1], path);
  assert.equal(open[open.indexOf("--label") + 1], "feat/new-thing");
  assert.ok(fx.calls().some((c) => c.join(" ") === "plugin action invoke maumercado.worktrunk.refresh"));
});

test("an existing branch skips the base prompt and is checked out, not created", async () => {
  const fx = withFixture();
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", fx.repo, "branch", "old-branch"]);
  const { picker, exited } = await startPicker(fx);
  press(picker, "n");
  type(picker, "old-branch");
  press(picker, "enter");
  assert.equal(picker.overlay.type, "choose");
  press(picker, "t");
  await waitFor(() => exited() !== null);
  assert.ok(existsSync(join(fx.root, "app.old-branch")));
  assert.ok(fx.calls().some((c) => c[0] === "tab" && c.includes(join(fx.root, "app.old-branch"))));
});

test("p checks out a PR by number", async () => {
  const fx = withFixture();
  // Point the PR at a branch without a worktree yet.
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", fx.repo, "branch", "pr-branch"]);
  writeFileSync(fx.env.FAKE_WT_PRS, JSON.stringify({ "pr-branch": { number: 77, status: "running" } }));
  const { picker, exited } = await startPicker(fx);
  press(picker, "p");
  type(picker, "77");
  press(picker, "enter", "enter");
  await waitFor(() => exited() !== null);
  assert.ok(existsSync(join(fx.root, "app.pr-branch")));
});

test("x removes a clean merged worktree, deletes its branch, closes its Space", async () => {
  const fx = withFixture();
  // Give feat-merged an open Space to be closed.
  const s = fx.state();
  s.workspaces.push({ workspace_id: "w5", number: 5, label: "merged", focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w5:t1", agent_status: "idle" });
  s.panes.push({ pane_id: "w5:p1", workspace_id: "w5", tab_id: "w5:t1", focused: false, cwd: fx.mergedPath, agent_status: "idle" });
  writeFileSync(fx.env.FAKE_HERDR_STATE, JSON.stringify(s));

  const { picker, screen } = await startPicker(fx);
  select(picker, "feat-merged");
  press(picker, "x");
  assert.match(screen.text(), /Remove worktree/);
  assert.match(screen.text(), /Space "merged"/);
  fx.clearCalls();
  press(picker, "y");
  await waitFor(() => !picker.busy);
  assert.ok(!existsSync(fx.mergedPath), "checkout removed");
  const { execFileSync } = await import("node:child_process");
  assert.equal(execFileSync("git", ["-C", fx.repo, "branch", "--list", "feat-merged"], { encoding: "utf8" }), "");
  assert.ok(fx.calls().some((c) => c.join(" ") === "workspace close w5"));
  assert.ok(!picker.rows().some((i) => i.branch === "feat-merged"), "list refreshed");
});

test("a dirty worktree is refused without force, and nothing is closed", async () => {
  const fx = withFixture();
  const { picker } = await startPicker(fx);
  select(picker, "feat-dirty");
  // On failure the picker waits for a key on real stdin; stub it.
  const { stdin } = process;
  const realOnce = stdin.once.bind(stdin);
  stdin.once = (ev, fn) => (ev === "data" ? setImmediate(fn) : realOnce(ev, fn));
  fx.clearCalls();
  press(picker, "x", "y");
  await waitFor(() => !picker.busy);
  stdin.once = realOnce;
  assert.ok(existsSync(fx.dirtyPath));
  assert.ok(!fx.calls().some((c) => c[1] === "close"), "no Herdr Space closed on failure");

  // With force it goes through.
  select(picker, "feat-dirty");
  press(picker, "x", "f", "D", "y");
  await waitFor(() => !picker.busy);
  assert.ok(!existsSync(fx.dirtyPath));
  assert.ok(fx.calls().some((c) => c.join(" ") === "workspace close w3"));
});

test("the primary worktree can't be removed", async () => {
  const fx = withFixture();
  const { picker } = await startPicker(fx);
  press(picker, "x");
  assert.equal(picker.overlay, null);
  assert.match(picker.message, /primary/);
});

test("remove-current mode targets the worktree of the focused pane", async () => {
  const fx = withFixture();
  process.env.HERDR_PLUGIN_CONTEXT_JSON = JSON.stringify({ workspace_id: "w2", focused_pane_id: "w2:p1", focused_pane_cwd: fx.prPath });
  const { picker, screen } = await startPicker(fx, "remove-current");
  assert.match(screen.text(), /feat-pr/);
  assert.equal(picker.overlay.type, "confirm");
  press(picker, "esc");
});

test("outside a git repo the picker explains and exits on a key", async () => {
  const fx = withFixture();
  process.env.HERDR_PLUGIN_CONTEXT_JSON = JSON.stringify({ focused_pane_cwd: fx.root });
  const { picker, screen, exited } = await startPicker(fx);
  assert.match(screen.text(), /Not inside a git repository/);
  press(picker, "q");
  assert.equal(exited(), 1);
});

test("b lists branches without a worktree; enter checks one out and opens it as a Space", async () => {
  const fx = withFixture();
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", fx.repo, "branch", "parked-work"]);
  const { picker, screen, exited } = await startPicker(fx);
  assert.ok(!picker.rows().some((i) => i.branch === "parked-work"), "hidden by default");
  press(picker, "b");
  await waitFor(() => !picker.loadingFull);
  picker.render();
  assert.match(screen.text(), /\/ parked-work.*no worktree yet/);
  select(picker, "parked-work");
  press(picker, "x");
  assert.match(picker.message, /No worktree/);
  fx.clearCalls();
  press(picker, "enter");
  await waitFor(() => exited() !== null);
  const path = join(fx.root, "app.parked-work");
  assert.ok(existsSync(path), "wt created the checkout");
  const open = fx.calls().find((c) => c[0] === "worktree" && c[1] === "open");
  assert.equal(open[open.indexOf("--path") + 1], path);
});

test("t on a branch without a worktree opens it as a tab in the current Space", async () => {
  const fx = withFixture();
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", fx.repo, "branch", "parked-tab"]);
  const { picker, exited } = await startPicker(fx);
  press(picker, "b");
  await waitFor(() => !picker.loadingFull);
  select(picker, "parked-tab");
  fx.clearCalls();
  press(picker, "t");
  await waitFor(() => exited() !== null);
  const tab = fx.calls().find((c) => c[0] === "tab");
  assert.equal(tab[tab.indexOf("--workspace") + 1], "w1");
  assert.equal(tab[tab.indexOf("--cwd") + 1], join(fx.root, "app.parked-tab"));
});
