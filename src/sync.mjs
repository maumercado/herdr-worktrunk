// Push PR / branch state for every open Space into Herdr workspace tokens.
//
// Event hooks fire often (focus changes, agent state changes), so a run is
// skipped when another one holds the lock or one finished a few seconds ago.
// `--force` bypasses the throttle but still respects the lock.
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listWorkspaces, listPanes, reportWorkspaceTokens } from "./herdr.mjs";
import { repoOf, wtList, canon, isInside } from "./wt.mjs";
import { describe } from "./status.mjs";
import { loadConfig } from "./config.mjs";
import { icons, lead } from "./icons.mjs";

const THROTTLE_MS = Number(process.env.WT_HERDR_THROTTLE_MS ?? loadConfig().syncThrottleSeconds * 1000);
const LOCK_STALE_MS = 90_000;

function stateDir() {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR || join(tmpdir(), "worktrunk-herdr");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function acquireLock(dir) {
  const lock = join(dir, "sync.lock");
  try {
    closeSync(openSync(lock, "wx"));
    return () => rmSync(lock, { force: true });
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        rmSync(lock, { force: true });
        closeSync(openSync(lock, "wx"));
        return () => rmSync(lock, { force: true });
      }
    } catch {
      /* someone else won the race */
    }
    return null;
  }
}

function readState(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "sync.json"), "utf8"));
  } catch {
    return {};
  }
}

/** Pick the directory that best represents a Space: its checkout, else its panes' cwd. */
export function workspaceDir(ws, panes) {
  if (ws.worktree?.checkout_path) return ws.worktree.checkout_path;
  const counts = new Map();
  for (const p of panes) {
    if (p.workspace_id !== ws.workspace_id) continue;
    const cwd = p.cwd || p.foreground_cwd;
    if (cwd) counts.set(cwd, (counts.get(cwd) ?? 0) + 1 + (p.focused ? 0.5 : 0));
  }
  let best = null;
  for (const [cwd, n] of counts) if (!best || n > best[1]) best = [cwd, n];
  return best?.[0] ?? null;
}

/** Match a checkout toplevel to its `wt list` item. */
export function itemForPath(items, toplevel) {
  const target = canon(toplevel);
  return (
    items.find((i) => i.worktree?.path && canon(i.worktree.path) === target) ??
    items.find((i) => i.worktree?.path && isInside(target, i.worktree.path)) ??
    null
  );
}

/** Branch tokens: plain name, and icon + name to color like the prompt's git segment. */
export function headTokens(item, I = icons()) {
  const name = item.branch ?? item.head?.short_sha ?? null;
  if (!name) return { wt_branch: null, wt_head: null };
  const glyph = item.branch ? I.branch : I.detached;
  return { wt_branch: name.slice(0, 80), wt_head: `${lead(glyph)}${name}`.slice(0, 80) };
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function syncStatus({ force = false, log = () => {} } = {}) {
  const dir = stateDir();
  const state = readState(dir);
  const workspaces = listWorkspaces();
  const ids = workspaces.map((w) => w.workspace_id);
  // A Space we have never reported on gets its tokens now, throttle or not.
  const hasNewSpace = ids.some((id) => !(state.known ?? []).includes(id));
  if (!force && !hasNewSpace && state.lastRun && Date.now() - state.lastRun < THROTTLE_MS) {
    log("throttled");
    return { skipped: "throttled" };
  }
  let release = acquireLock(dir);
  // A forced run waits for the current one so its result reflects the latest change.
  for (let waited = 0; !release && force && waited < 60_000; waited += 250) {
    sleep(250);
    release = acquireLock(dir);
  }
  if (!release) {
    log("locked");
    return { skipped: "locked" };
  }
  try {
    // Re-read: a forced run may have waited for the lock.
    const current = force ? listWorkspaces() : workspaces;
    writeFileSync(
      join(dir, "sync.json"),
      JSON.stringify({ lastRun: Date.now(), known: current.map((w) => w.workspace_id) }),
    );

    const panes = listPanes();

    // Group Spaces by repo so `wt list --full` runs once per repo.
    const repos = new Map();
    for (const ws of current) {
      const wsDir = workspaceDir(ws, panes);
      const repo = wsDir && repoOf(wsDir);
      if (!repo) continue;
      if (!repos.has(repo.commonDir)) repos.set(repo.commonDir, { dir: repo.toplevel, spaces: [] });
      repos.get(repo.commonDir).spaces.push({ ws, toplevel: repo.toplevel });
    }

    let seq = Date.now() * 1000;
    let updated = 0;
    const errors = [];
    for (const [key, repo] of repos) {
      let list;
      try {
        list = wtList(repo.dir, { full: true });
      } catch (error) {
        // Network or forge trouble: fall back to local-only state.
        log(`full list failed for ${key}: ${error.message}`);
        try {
          list = wtList(repo.dir, { full: false });
        } catch (inner) {
          errors.push(inner.message);
          continue;
        }
      }
      for (const { ws, toplevel } of repo.spaces) {
        const item = itemForPath(list.items, toplevel);
        if (!item) continue;
        const { tokens } = describe(item);
        if (tokens.wt_url && tokens.wt_url.length > 80) tokens.wt_url = null;
        Object.assign(tokens, headTokens(item));
        reportWorkspaceTokens(ws.workspace_id, tokens, seq++);
        updated++;
      }
    }
    log(`updated ${updated} space(s)`);
    return { updated, errors };
  } finally {
    release();
  }
}
