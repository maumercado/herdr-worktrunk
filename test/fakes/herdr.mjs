#!/usr/bin/env node
// Stand-in for the Herdr CLI. Keeps workspaces/panes in $FAKE_HERDR_STATE,
// logs every call to $FAKE_HERDR_LOG, and answers with the response envelopes
// from herdr 0.9.5's src/api/schema (WorkspaceInfo, PaneInfo, WorktreeOpened...).
import { readFileSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const STATE = process.env.FAKE_HERDR_STATE;
const state = JSON.parse(readFileSync(STATE, "utf8"));
appendFileSync(process.env.FAKE_HERDR_LOG, `${JSON.stringify(argv)}\n`);

const ok = (result) => {
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  process.stdout.write(JSON.stringify({ id: "cli:1", result }));
  process.exit(0);
};
const fail = (code, message) => {
  process.stderr.write(JSON.stringify({ id: "cli:1", error: { code, message } }));
  process.exit(1);
};
const opt = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const all = (flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));
const canon = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

function newWorkspace({ label, cwd, worktree }) {
  const n = state.next++;
  const ws = {
    workspace_id: `w${n}`,
    number: n,
    label,
    focused: true,
    pane_count: 1,
    tab_count: 1,
    active_tab_id: `w${n}:t1`,
    agent_status: "unknown",
    ...(worktree ? { worktree } : {}),
  };
  for (const w of state.workspaces) w.focused = false;
  state.workspaces.push(ws);
  const pane = { pane_id: `w${n}:p1`, terminal_id: `term${n}`, workspace_id: ws.workspace_id, tab_id: `w${n}:t1`, focused: true, cwd, agent_status: "unknown" };
  state.panes.push(pane);
  return { ws, pane };
}

const [a, b] = argv;
const key = `${a} ${b}`;

switch (key) {
  case "workspace list":
    ok({ type: "workspace_list", workspaces: state.workspaces });
  case "pane list":
    ok({ type: "pane_list", panes: state.panes });
  case "workspace report-metadata": {
    const ws = state.workspaces.find((w) => w.workspace_id === argv[2]);
    if (!ws) fail("workspace_not_found", "no such workspace");
    ws.tokens ??= {};
    for (const t of all("--token")) {
      const [k, ...v] = t.split("=");
      ws.tokens[k] = v.join("=");
    }
    for (const k of all("--clear-token")) delete ws.tokens[k];
    ok({ type: "workspace_info", workspace: ws });
  }
  case "worktree open": {
    const repo = opt("--cwd");
    const path = canon(opt("--path"));
    const list = spawnSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" }).stdout;
    const paths = list.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => canon(l.slice(9)));
    if (!paths.includes(path)) fail("worktree_not_found", "worktree path not found");
    const open = state.workspaces.find((w) => w.worktree && canon(w.worktree.checkout_path) === path);
    if (open) ok({ type: "worktree_opened", workspace: open, already_open: true });
    const { ws, pane } = newWorkspace({
      label: opt("--label"),
      cwd: path,
      worktree: { repo_key: paths[0], repo_name: "repo", repo_root: paths[0], checkout_path: path, is_linked_worktree: path !== paths[0] },
    });
    ok({ type: "worktree_opened", workspace: ws, tab: { tab_id: ws.active_tab_id }, root_pane: pane, worktree: { path }, already_open: false });
  }
  case "workspace create": {
    const { ws, pane } = newWorkspace({ label: opt("--label"), cwd: opt("--cwd") });
    ok({ type: "workspace_created", workspace: ws, tab: { tab_id: ws.active_tab_id }, root_pane: pane });
  }
  case "workspace close": {
    state.workspaces = state.workspaces.filter((w) => w.workspace_id !== argv[2]);
    state.panes = state.panes.filter((p) => p.workspace_id !== argv[2]);
    ok({ type: "ok" });
  }
  case "tab create": {
    const wsId = opt("--workspace") ?? state.workspaces.find((w) => w.focused)?.workspace_id;
    const id = `${wsId}:t${state.next++}`;
    const pane = { pane_id: `${wsId}:p${state.next++}`, workspace_id: wsId, tab_id: id, focused: true, cwd: opt("--cwd"), agent_status: "unknown" };
    state.panes.push(pane);
    ok({ type: "tab_created", tab: { tab_id: id, workspace_id: wsId, label: opt("--label") }, root_pane: pane });
  }
  case "pane split": {
    const src = state.panes.find((p) => p.pane_id === opt("--pane")) ?? state.panes[0];
    const pane = { pane_id: `${src.workspace_id}:p${state.next++}`, workspace_id: src.workspace_id, tab_id: src.tab_id, focused: true, cwd: opt("--cwd"), agent_status: "unknown" };
    state.panes.push(pane);
    ok({ type: "pane_info", pane });
  }
  case "pane close": {
    state.panes = state.panes.filter((p) => p.pane_id !== argv[2]);
    ok({ type: "ok" });
  }
  case "pane rename":
  case "notification show":
  case "plugin action":
  case "plugin pane":
    ok({ type: "ok" });
  default:
    fail("unknown", `fake herdr does not handle: ${argv.join(" ")}`);
}
