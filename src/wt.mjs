// Worktrunk (wt) client plus the bits of git we need to find a repo.
import { realpathSync } from "node:fs";
import { run, runJson, runInteractive, runAsync } from "./exec.mjs";

import { loadConfig } from "./config.mjs";

// Herdr's server may not share your shell's PATH; set "wtBin" in config.json if needed.
let wtBin;
export const WT = () => (wtBin ??= process.env.WT_HERDR_WT_BIN || loadConfig().wtBin || "wt");

/** Canonical path, or the input when it no longer exists (e.g. just removed). */
export function canon(p) {
  if (!p) return p;
  try {
    return realpathSync(p);
  } catch {
    return p.replace(/\/+$/, "");
  }
}

export function isInside(child, parent) {
  if (!child || !parent) return false;
  const c = canon(child);
  const p = canon(parent);
  return c === p || c.startsWith(p.endsWith("/") ? p : `${p}/`);
}

/**
 * Resolve the repo that `dir` belongs to. Returns null outside a git repo.
 * `commonDir` is the same for every worktree of a repo, so it is the repo key.
 */
export function repoOf(dir) {
  if (!dir) return null;
  const res = run("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], {
    allowFail: true,
    timeout: 5_000,
  });
  if (res.status !== 0) return null;
  const [toplevel, commonDir] = res.stdout.trim().split("\n");
  if (!toplevel || !commonDir) return null;
  return { toplevel: canon(toplevel), commonDir: canon(commonDir) };
}

/**
 * `wt list --format=json` (schema 2). With `full`, CI/PR facts are collected;
 * LLM summaries are always turned off here since they can be slow and cost money.
 */
export function wtList(dir, { full = false, branches = false, timeout } = {}) {
  const args = ["-C", dir, "list", "--format=json", "--no-progressive", "--config-set", "list.summary=false"];
  if (full) args.push("--full");
  if (branches) args.push("--branches");
  const body = runJson(WT(), args, { timeout: timeout ?? (full ? 45_000 : 15_000) });
  return normalizeList(body);
}

export async function wtListAsync(dir, { full = false, branches = false } = {}) {
  const args = ["-C", dir, "list", "--format=json", "--no-progressive", "--config-set", "list.summary=false"];
  if (full) args.push("--full");
  if (branches) args.push("--branches");
  const { stdout } = await runAsync(WT(), args, { timeout: full ? 45_000 : 15_000 });
  return normalizeList(JSON.parse(stdout));
}

/** Accept schema 2 (envelope) and schema 1 (bare array, for users who pinned it). */
export function normalizeList(body) {
  if (Array.isArray(body)) {
    return {
      defaultBranch: null,
      collectedCi: body.some((i) => i.ci),
      items: body.map(fromSchema1),
    };
  }
  return {
    defaultBranch: body?.repo?.default_branch ?? null,
    forgeUrl: body?.repo?.forge?.url ?? null,
    collectedCi: !!body?.collected?.ci,
    items: (body?.items ?? []).filter((i) => !i.remote),
  };
}

function fromSchema1(i) {
  return {
    branch: i.branch,
    head: i.commit ? { short_sha: i.commit.short_sha, subject: i.commit.message } : null,
    worktree:
      i.kind === "worktree" || i.path
        ? {
            path: i.path,
            main: !!i.is_main,
            current: !!i.is_current,
            detached: !!i.worktree?.detached,
            changes: i.working_tree ?? null,
          }
        : undefined,
    default_branch: i.main ? { ahead: i.main.ahead, behind: i.main.behind } : undefined,
    upstream: i.remote ? { ahead: i.remote.ahead, behind: i.remote.behind } : undefined,
    pr: i.ci?.number ? { number: i.ci.number, url: i.ci.url, review: i.ci.review_state } : undefined,
    checks: i.ci?.status ? { status: i.ci.status, stale: !!i.ci.stale } : undefined,
    display: { state: i.main_state, symbols: i.symbols },
  };
}

/** Worktree rows only, primary first. */
export function worktreeItems(list) {
  return list.items
    .filter((i) => i.worktree?.path)
    .sort((a, b) => Number(!!b.worktree.main) - Number(!!a.worktree.main));
}

export function primaryOf(list) {
  return worktreeItems(list).find((i) => i.worktree.main) ?? worktreeItems(list)[0] ?? null;
}

/**
 * `wt switch` without changing anyone's directory. Runs attached to the
 * terminal so Worktrunk can ask to approve project hooks the first time.
 */
export async function wtSwitch(dir, target, { create = false, base } = {}) {
  const args = ["-C", dir, "switch", "--no-cd", "--format=json"];
  if (create) args.push("--create");
  if (base) args.push("--base", base);
  args.push(target);
  const res = await runInteractive(WT(), args);
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout.trim().split("\n").filter(Boolean).pop() || "null");
  } catch {
    parsed = null;
  }
  // wt prints a result even when a later step failed, as long as the worktree exists.
  if (parsed?.path) return { ...parsed, status: res.status };
  const err = new Error(`wt switch ${target} failed (exit ${res.status ?? res.error?.code})`);
  err.status = res.status;
  throw err;
}

/** `wt remove`, foreground so we know when the checkout is gone. */
export async function wtRemove(dir, target, { force = false, forceDelete = false, keepBranch = false } = {}) {
  const args = ["-C", dir, "remove", "--foreground", "--format=json"];
  if (force) args.push("--force");
  if (forceDelete) args.push("--force-delete");
  if (keepBranch) args.push("--no-delete-branch");
  args.push(target);
  const res = await runInteractive(WT(), args);
  const results = res.stdout
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .flat();
  if (res.status !== 0) {
    const err = new Error(`wt remove ${target} failed (exit ${res.status ?? res.error?.code})`);
    err.status = res.status;
    throw err;
  }
  return results[0] ?? { branch: target };
}

/** Parse "https://github.com/o/r/pull/12/..." into "pr:12". */
export function prRefFromUrl(url) {
  const m = /\/pull\/(\d+)/.exec(url || "");
  return m ? `pr:${m[1]}` : null;
}
