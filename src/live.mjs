// Live status: keeps sidebar tokens in step with git as you work.
//
// Started by the plugin's [[startup]] hook and runs until the Herdr server goes
// away. It does three things:
//
//   1. Follows Herdr: subscribes to workspace/pane/worktree events on the socket
//      (and re-checks every few seconds as a safety net) to know which checkout
//      each Space shows.
//   2. Follows git: fs.watch on each checkout, its git dir and the repo's refs.
//      Any change schedules a local `wt list` for that repo (debounced, ~200 ms),
//      so edits, staging, commits, checkouts and pushes show up right away.
//   3. Follows the forge: `wt list --full` every `prPollSeconds` (and every 10 s
//      while checks are running, and right after a push or fetch) for PR, CI
//      and review state.
//
// Only tokens that changed are sent to Herdr. Event hooks still run `sync`, but
// it returns at once while this watcher is alive.
import { watch, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { listWorkspaces, listPanes, reportWorkspaceTokens } from "./herdr.mjs";
import { repoOf, wtListAsync } from "./wt.mjs";
import { run } from "./exec.mjs";
import { describe } from "./status.mjs";
import { workspaceDir, itemForPath, headTokens } from "./sync.mjs";
import { loadConfig } from "./config.mjs";
import { subscribe, eventType } from "./socket.mjs";

export const EVENTS = [
  "workspace.created",
  "workspace.updated",
  "workspace.closed",
  "workspace.focused",
  "pane.created",
  "pane.updated",
  "pane.closed",
  "pane.focused",
  "worktree.created",
  "worktree.opened",
  "worktree.removed",
];

const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== "" ? Number(v) : d);
const BEAT_MS = 5_000;
const STALE_MS = 20_000;

export function stateDir() {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR || join(tmpdir(), "worktrunk-herdr");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const liveFile = () => join(stateDir(), "live.json");

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Is a watcher running right now? Used by `sync` hooks to stand down. */
export function liveRunning() {
  try {
    const info = JSON.parse(readFileSync(liveFile(), "utf8"));
    return Date.now() - info.beat < STALE_MS && pidAlive(info.pid) ? info : null;
  } catch {
    return null;
  }
}

// Paths under .git that change all the time without changing status.
const NOISE = /(^|\/)\.git\/(objects|logs|lfs|fsmonitor--daemon|hooks)(\/|$)|\.lock$|(^|\/)\.DS_Store$/;
const REMOTE_REF = /(^|\/)(refs\/remotes|FETCH_HEAD|packed-refs)(\/|$)/;

export class Live {
  constructor({ log = () => {}, config = loadConfig(), env = process.env } = {}) {
    this.log = log;
    this.config = config;
    this.debounceMs = num(env.WT_HERDR_LIVE_DEBOUNCE_MS, 200);
    this.maxWaitMs = num(env.WT_HERDR_LIVE_MAX_WAIT_MS, 1_000);
    this.reconcileMs = num(env.WT_HERDR_LIVE_RECONCILE_MS, 4_000);
    this.prPollMs = num(env.WT_HERDR_PR_POLL_MS, num(config.prPollSeconds, 30) * 1000);
    this.prBusyMs = Math.min(this.prPollMs, num(env.WT_HERDR_PR_BUSY_MS, 10_000));
    this.repos = new Map(); // commonDir -> repo state
    this.spaces = new Map(); // workspace id -> { repoKey, toplevel }
    this.sent = new Map(); // workspace id -> JSON of last tokens sent
    this.seq = Date.now() * 1000;
    this.timers = new Set();
    this.socket = null;
    this.herdrFailures = 0;
    this.stopped = false;
    this.done = new Promise((resolve) => (this.finish = resolve));
  }

  // ------------------------------------------------------------ lifecycle

  async start() {
    const other = liveRunning();
    if (other && other.pid !== process.pid) {
      this.log(`already running (pid ${other.pid})`);
      return false;
    }
    this.beat();
    this.every(BEAT_MS, () => this.beat());
    this.reconcile();
    try {
      this.socket = await subscribe(EVENTS, {
        onEvent: (msg) => this.onEvent(msg),
        onClose: () => this.stop("herdr socket closed"),
      });
      this.log("subscribed to herdr events");
    } catch (error) {
      // No socket (older Herdr, odd setup): poll Herdr more often instead.
      this.log(`no event socket (${error.message}); polling`);
      this.reconcileMs = Math.min(this.reconcileMs, num(process.env.WT_HERDR_LIVE_POLL_MS, 2_000));
    }
    this.every(this.reconcileMs, () => this.reconcile());
    return true;
  }

  stop(reason = "stopped") {
    if (this.stopped) return;
    this.stopped = true;
    this.log(reason);
    for (const t of this.timers) clearInterval(t), clearTimeout(t);
    for (const repo of this.repos.values()) this.unwatch(repo);
    this.socket?.close();
    try {
      const info = JSON.parse(readFileSync(liveFile(), "utf8"));
      if (info.pid === process.pid) rmSync(liveFile(), { force: true });
    } catch {
      /* already gone */
    }
    this.finish(reason);
  }

  beat() {
    writeFileSync(liveFile(), JSON.stringify({ pid: process.pid, beat: Date.now(), socket: !!this.socket }));
  }

  every(ms, fn) {
    const t = setInterval(fn, ms);
    this.timers.add(t);
    return t;
  }

  later(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  onEvent(msg) {
    const type = eventType(msg);
    this.log(`event ${type ?? "?"}`);
    // Let Herdr finish what it is doing (a new pane gets its cwd a beat later).
    clearTimeout(this.reconcileSoon);
    this.reconcileSoon = this.later(80, () => this.reconcile());
  }

  // ------------------------------------------------------------ Spaces

  /** Map every Space to a checkout, start or stop watchers to match. */
  reconcile() {
    if (this.stopped) return;
    let workspaces;
    let panes;
    try {
      workspaces = listWorkspaces();
      panes = listPanes();
      this.herdrFailures = 0;
    } catch (error) {
      // Herdr gone without closing the socket (or no socket at all).
      if (++this.herdrFailures >= 3) this.stop(`herdr unreachable: ${error.message}`);
      return;
    }

    const seen = new Set();
    const touched = new Set();
    for (const ws of workspaces) {
      const dir = workspaceDir(ws, panes);
      const repo = dir && repoOf(dir);
      if (!repo) continue;
      const id = ws.workspace_id;
      seen.add(id);
      const prev = this.spaces.get(id);
      if (prev?.toplevel === repo.toplevel) continue;
      this.spaces.set(id, { repoKey: repo.commonDir, toplevel: repo.toplevel });
      this.sent.delete(id);
      this.ensureRepo(repo).toplevels.add(repo.toplevel);
      touched.add(repo.commonDir);
    }
    for (const id of [...this.spaces.keys()]) {
      if (!seen.has(id)) {
        this.spaces.delete(id);
        this.sent.delete(id);
      }
    }

    // Rebuild watchers for repos whose set of checkouts changed; drop unused repos.
    for (const [key, repo] of this.repos) {
      const used = new Set([...this.spaces.values()].filter((s) => s.repoKey === key).map((s) => s.toplevel));
      if (!used.size) {
        this.unwatch(repo);
        this.repos.delete(key);
        continue;
      }
      if (touched.has(key) || used.size !== repo.toplevels.size) {
        repo.toplevels = used;
        this.rewatch(repo);
        // New Space: show what we know now, then local status, then PR state.
        this.publish(repo);
        this.bump(repo);
        if (!repo.full) this.scheduleFull(repo, 0);
      }
    }
  }

  ensureRepo(r) {
    if (!this.repos.has(r.commonDir)) {
      this.repos.set(r.commonDir, {
        key: r.commonDir,
        dir: r.toplevel,
        toplevels: new Set(),
        watchers: [],
        local: null, // last `wt list` items
        full: null, // branch -> { pr, checks } from the last `wt list --full`
        localAt: 0,
        timer: null,
        firstBump: 0,
        running: false,
        again: false,
        fullRunning: false,
        fullTimer: null,
        fullDue: 0,
        polling: false,
      });
    }
    return this.repos.get(r.commonDir);
  }

  // ------------------------------------------------------------ git watching

  rewatch(repo) {
    this.unwatch(repo);
    const onChange = (base) => (_event, file) => {
      const rel = file ? `${base}/${file}` : base;
      if (file && NOISE.test(rel)) return;
      this.bump(repo, { local: true, remoteSoon: REMOTE_REF.test(rel) });
    };
    const add = (path, recursive, label) => {
      try {
        const w = watch(path, { recursive, persistent: true }, onChange(label));
        w.on("error", () => this.fallbackPoll(repo));
        repo.watchers.push(w);
      } catch (error) {
        this.log(`watch ${path} failed: ${error.message}`);
        this.fallbackPoll(repo);
      }
    };
    for (const top of repo.toplevels) {
      add(top, true, basename(top));
      // Linked worktrees keep HEAD and index outside the checkout.
      const gitDir = run("git", ["-C", top, "rev-parse", "--absolute-git-dir"], { allowFail: true, timeout: 5_000 }).stdout?.trim();
      if (gitDir && !gitDir.startsWith(`${top}/`)) add(gitDir, false, ".git");
    }
    if (![...repo.toplevels].some((t) => repo.key.startsWith(`${t}/`))) add(repo.key, false, ".git");
    add(join(repo.key, "refs"), true, ".git/refs");
  }

  unwatch(repo) {
    for (const w of repo.watchers) w.close();
    repo.watchers = [];
  }

  /** When fs.watch is not available (too many files, odd filesystem), poll instead. */
  fallbackPoll(repo) {
    if (repo.polling) return;
    repo.polling = true;
    this.log(`polling ${repo.dir}`);
    this.every(num(process.env.WT_HERDR_LIVE_POLL_MS, 2_000), () => this.repos.has(repo.key) && this.bump(repo, { local: true }));
  }

  // ------------------------------------------------------------ refreshing
  //
  // Two lanes per repo, so a slow forge call never holds up local status:
  //   local: `wt list`, debounced, after any file or ref change
  //   full:  `wt list --full`, on a timer and after pushes/fetches

  /**
   * Debounced local refresh. Bursts of file events collapse into one `wt list`,
   * which still runs at most `maxWaitMs` after the first event of a long burst.
   */
  bump(repo, { remoteSoon = false } = {}) {
    if (this.stopped) return;
    if (remoteSoon) this.scheduleFull(repo, 1_500);
    const now = Date.now();
    if (!repo.timer) repo.firstBump = now;
    clearTimeout(repo.timer);
    const wait = Math.max(0, Math.min(this.debounceMs, repo.firstBump + this.maxWaitMs - now));
    repo.timer = this.later(wait, () => {
      repo.timer = null;
      this.refreshLocal(repo);
    });
  }

  async refreshLocal(repo) {
    if (repo.running) {
      repo.again = true;
      return;
    }
    repo.running = true;
    const started = Date.now();
    try {
      const list = await wtListAsync(repo.dir, { full: false });
      if (started >= (repo.localAt ?? 0)) {
        repo.local = list.items;
        repo.localAt = started;
      }
      this.publish(repo);
    } catch (error) {
      this.log(`wt list failed for ${repo.dir}: ${error.message}`);
    } finally {
      repo.running = false;
      if (repo.again && !this.stopped) {
        repo.again = false;
        this.bump(repo);
      }
    }
  }

  async refreshFull(repo) {
    if (repo.fullRunning || this.stopped || !this.repos.has(repo.key)) return;
    repo.fullRunning = true;
    const started = Date.now();
    try {
      const list = await wtListAsync(repo.dir, { full: true });
      // Its local half is only used if no newer local run finished meanwhile.
      if (started >= (repo.localAt ?? 0)) {
        repo.local = list.items;
        repo.localAt = started;
      }
      this.rememberFull(repo, list);
      this.publish(repo);
    } catch (error) {
      // Offline or forge trouble: local status keeps flowing, retry later.
      this.log(`wt list --full failed for ${repo.dir}: ${error.message}`);
      this.scheduleFull(repo, this.prPollMs);
    } finally {
      repo.fullRunning = false;
    }
  }

  rememberFull(repo, list) {
    repo.full = new Map();
    let busy = false;
    for (const item of list.items) {
      if (!item.branch) continue;
      repo.full.set(item.branch, { pr: item.pr ?? null, checks: item.checks ?? null });
      if (item.checks?.status === "running") busy = true;
    }
    this.scheduleFull(repo, busy ? this.prBusyMs : this.prPollMs);
  }

  scheduleFull(repo, ms) {
    if (repo.fullTimer && repo.fullDue <= Date.now() + ms) return;
    clearTimeout(repo.fullTimer);
    repo.fullDue = Date.now() + ms;
    repo.fullTimer = this.later(ms, () => {
      repo.fullTimer = null;
      this.refreshFull(repo);
    });
  }

  /** Local items plus the PR facts from the last full run. */
  merged(repo) {
    if (!repo.local) return null;
    if (!repo.full) return repo.local;
    return repo.local.map((item) => {
      if (item.pr || !item.branch) return item;
      const f = repo.full.get(item.branch);
      return f?.pr ? { ...item, pr: f.pr, checks: f.checks } : item;
    });
  }

  publish(repo) {
    const items = this.merged(repo);
    if (!items) return;
    for (const [id, space] of this.spaces) {
      if (space.repoKey !== repo.key) continue;
      const item = itemForPath(items, space.toplevel);
      if (!item) continue;
      const { tokens } = describe(item);
      if (tokens.wt_url && tokens.wt_url.length > 80) tokens.wt_url = null;
      Object.assign(tokens, headTokens(item));
      const key = JSON.stringify(tokens);
      if (this.sent.get(id) === key) continue;
      this.sent.set(id, key);
      reportWorkspaceTokens(id, tokens, this.seq++);
      this.log(`${id}: ${tokens.wt_status}`);
    }
  }
}

/** Entry point for `main.mjs live`. Resolves when the watcher stops. */
export async function runLive({ log = () => {} } = {}) {
  const live = new Live({ log });
  const stop = (sig) => live.stop(`got ${sig}`);
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(sig, () => stop(sig));
  if (!(await live.start())) return 0;
  await live.done;
  return 0;
}
