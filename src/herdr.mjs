// Herdr CLI client. Every call goes through HERDR_BIN_PATH so the plugin talks
// to the server that launched it.
import { runJson, run } from "./exec.mjs";

const BIN = () => process.env.HERDR_BIN_PATH || "herdr";

/** Call `herdr <args>` and return `.result` of the JSON envelope. */
export function herdr(args, opts = {}) {
  const body = runJson(BIN(), args, { timeout: 15_000, ...opts });
  if (body?.error) {
    const err = new Error(`herdr ${args.join(" ")}: ${body.error.code}: ${body.error.message}`);
    err.code = body.error.code;
    throw err;
  }
  return body?.result ?? body;
}

/** Fire-and-check variant for calls whose output we do not need. */
export function herdrQuiet(args) {
  return run(BIN(), args, { timeout: 15_000, allowFail: true });
}

export const listWorkspaces = () => herdr(["workspace", "list"]).workspaces ?? [];
export const listPanes = () => herdr(["pane", "list"]).panes ?? [];

export function notify(title, body) {
  const args = ["notification", "show", title.slice(0, 80)];
  if (body) args.push("--body", body.slice(0, 240));
  herdrQuiet(args);
}

/** Context Herdr passes to every plugin command. */
export function invocationContext() {
  let ctx = {};
  try {
    ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    ctx = {};
  }
  return {
    workspaceId: ctx.workspace_id ?? process.env.HERDR_WORKSPACE_ID,
    tabId: ctx.tab_id ?? process.env.HERDR_TAB_ID,
    paneId: ctx.focused_pane_id ?? process.env.HERDR_PANE_ID,
    cwd: ctx.focused_pane_cwd ?? ctx.workspace_cwd ?? ctx.worktree?.checkout_path ?? process.env.PWD,
    worktree: ctx.worktree,
    clickedUrl: ctx.clicked_url ?? process.env.HERDR_PLUGIN_CLICKED_URL,
    raw: ctx,
  };
}

// ----------------------------------------------------------------- opening

/**
 * Open a checkout as a Herdr Space (workspace). `worktree open` groups it under
 * the repo's own Space and returns the existing Space when it is already open.
 * Falls back to a plain workspace when Herdr cannot match the checkout.
 */
export function openAsSpace({ primaryPath, path, label }) {
  try {
    const res = herdr(["worktree", "open", "--cwd", primaryPath, "--path", path, "--label", label, "--focus"]);
    return { workspaceId: res.workspace?.workspace_id, alreadyOpen: !!res.already_open };
  } catch (error) {
    const res = herdr(["workspace", "create", "--cwd", path, "--label", label, "--focus"]);
    return { workspaceId: res.workspace?.workspace_id, alreadyOpen: false, fallback: error.message };
  }
}

export function openAsTab({ workspaceId, path, label }) {
  const args = ["tab", "create", "--cwd", path, "--label", label, "--focus"];
  if (workspaceId) args.push("--workspace", workspaceId);
  const res = herdr(args);
  return { tabId: res.tab?.tab_id, paneId: res.root_pane?.pane_id };
}

export function openAsSplit({ paneId, path, label, direction = "right" }) {
  const args = ["pane", "split", "--direction", direction, "--cwd", path, "--focus"];
  if (paneId) args.push("--pane", paneId);
  const res = herdr(args);
  const newPane = res.pane?.pane_id;
  if (newPane) herdrQuiet(["pane", "rename", newPane, label]);
  return { paneId: newPane };
}

/** Ask Herdr to open one of this plugin's panes (used by actions). */
export function openPluginPane(entrypoint, env = {}) {
  const args = ["plugin", "pane", "open", "--plugin", process.env.HERDR_PLUGIN_ID, "--entrypoint", entrypoint];
  for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
  return herdr(args);
}

// ----------------------------------------------------------------- metadata

/**
 * Patch workspace tokens. `tokens` maps name -> string | null (null clears).
 * `seq` lets Herdr drop stale reports from overlapping hook runs.
 */
export function reportWorkspaceTokens(workspaceId, tokens, seq) {
  const args = ["workspace", "report-metadata", workspaceId, "--source", tokenSource()];
  for (const [name, value] of Object.entries(tokens)) {
    if (value === null || value === undefined || value === "") args.push("--clear-token", name);
    else args.push("--token", `${name}=${value}`);
  }
  if (seq !== undefined) args.push("--seq", String(seq));
  return herdrQuiet(args);
}

export function tokenSource() {
  return `plugin:${process.env.HERDR_PLUGIN_ID || "maumercado.worktrunk"}`.slice(0, 80);
}
