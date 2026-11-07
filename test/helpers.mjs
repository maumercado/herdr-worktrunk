// Shared fixture: a real git repo with three linked worktrees, a fake Herdr
// state with Spaces pointing at them, and env wiring for the fake CLIs.
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_WT = join(here, "fakes", "wt.mjs");
export const FAKE_HERDR = join(here, "fakes", "herdr.mjs");
export const MAIN = join(here, "..", "src", "main.mjs");

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wt-herdr-test-")));
  const repo = join(root, "app");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");

  const wt = (branch) => {
    const p = join(root, `app.${branch}`);
    git(repo, "worktree", "add", "-q", "-b", branch, p);
    return p;
  };
  const prPath = wt("feat-pr");
  writeFileSync(join(prPath, "a.txt"), "a\n");
  git(prPath, "add", ".");
  git(prPath, "commit", "-qm", "pr work");
  const dirtyPath = wt("feat-dirty");
  writeFileSync(join(dirtyPath, "b.txt"), "b\n");
  git(dirtyPath, "commit", "--allow-empty", "-qm", "x");
  writeFileSync(join(dirtyPath, "untracked.txt"), "u\n");
  writeFileSync(join(dirtyPath, "README.md"), "changed\n");
  const mergedPath = wt("feat-merged");

  const prs = join(root, "prs.json");
  writeFileSync(
    prs,
    JSON.stringify({ "feat-pr": { number: 42, url: "https://github.com/acme/app/pull/42", review: "approved", status: "passed" } }),
  );

  const linked = (path) => ({ repo_key: repo, repo_name: "app", repo_root: repo, checkout_path: path, is_linked_worktree: path !== repo });
  const ws = (n, label, cwd, worktree) => ({
    workspace_id: `w${n}`, number: n, label, focused: n === 1, pane_count: 1, tab_count: 1,
    active_tab_id: `w${n}:t1`, agent_status: "idle", ...(worktree ? { worktree } : {}),
  });
  const pane = (n, cwd) => ({ pane_id: `w${n}:p1`, terminal_id: `t${n}`, workspace_id: `w${n}`, tab_id: `w${n}:t1`, focused: n === 1, cwd, agent_status: "idle" });
  const state = {
    next: 10,
    workspaces: [ws(1, "app", repo), ws(2, "feat-pr", prPath, linked(prPath)), ws(3, "dirty work", dirtyPath)],
    // w3 has no worktree provenance: its directory comes from the pane cwd (a subdir).
    panes: [pane(1, repo), pane(2, prPath), pane(3, join(dirtyPath))],
  };
  const stateFile = join(root, "herdr-state.json");
  writeFileSync(stateFile, JSON.stringify(state));
  const herdrLog = join(root, "herdr.log");
  writeFileSync(herdrLog, "");
  const pluginState = join(root, "plugin-state");
  const pluginConfig = join(root, "plugin-config");
  mkdirSync(pluginState);
  mkdirSync(pluginConfig);
  // Existing assertions read the plain Unicode set; Nerd Font output has its own tests.
  writeFileSync(join(pluginConfig, "config.json"), JSON.stringify({ icons: "unicode" }));

  const env = {
    HERDR_BIN_PATH: FAKE_HERDR,
    WT_HERDR_WT_BIN: FAKE_WT,
    HERDR_PLUGIN_ID: "maumercado.worktrunk",
    HERDR_PLUGIN_STATE_DIR: pluginState,
    HERDR_PLUGIN_CONFIG_DIR: pluginConfig,
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: "w1", focused_pane_id: "w1:p1", focused_pane_cwd: repo }),
    FAKE_HERDR_STATE: stateFile,
    FAKE_HERDR_LOG: herdrLog,
    FAKE_WT_PRS: prs,
  };
  return {
    root, repo, prPath, dirtyPath, mergedPath, env,
    state: () => JSON.parse(readFileSync(stateFile, "utf8")),
    calls: () => readFileSync(herdrLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    clearCalls: () => writeFileSync(herdrLog, ""),
  };
}

export function fakeScreen() {
  const written = [];
  return {
    active: false,
    cols: 140,
    rows: 30,
    last: [],
    out: { write: (s) => written.push(s) },
    written,
    enter() { this.active = true; },
    leave() { this.active = false; },
    draw(lines) { this.last = lines.map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")); },
    onKey: null,
    text() { return this.last.join("\n"); },
  };
}
