#!/usr/bin/env node
// Stand-in for Worktrunk's `wt`, backed by real git worktrees. Emits the
// documented JSON shapes (wt list schema 2, wt switch/remove --format=json).
// PR facts come from $FAKE_WT_PRS (JSON: { branch: { number, url, review, status, mergeable } }).
import { spawnSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";

const argv = process.argv.slice(2);
if (process.env.FAKE_WT_LOG) appendFileSync(process.env.FAKE_WT_LOG, `${JSON.stringify(argv)}\n`);

let dir = process.cwd();
const take = (flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const [, v] = argv.splice(i, 2);
  return v;
};
dir = take("-C") ?? dir;
take("--config-set");
const has = (flag) => {
  const i = argv.indexOf(flag);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};

function git(args, cwd = dir, allowFail = false) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0 && !allowFail) {
    process.stderr.write(r.stderr);
    process.exit(1);
  }
  return r;
}

function worktrees() {
  const out = git(["worktree", "list", "--porcelain"]).stdout;
  return out
    .trim()
    .split("\n\n")
    .map((block) => {
      const w = {};
      for (const line of block.split("\n")) {
        const [k, ...v] = line.split(" ");
        w[k] = v.join(" ") || true;
      }
      return { path: w.worktree, branch: typeof w.branch === "string" ? w.branch.replace("refs/heads/", "") : null, head: w.HEAD };
    });
}

function changes(path) {
  const lines = git(["status", "--porcelain=v1"], path).stdout.split("\n").filter(Boolean);
  const c = { staged: false, modified: false, untracked: false, renamed: false, deleted: false, conflicted: false };
  for (const l of lines) {
    if (l.startsWith("??")) c.untracked = true;
    else {
      if (l[0] !== " ") c.staged = true;
      if (l[1] === "M") c.modified = true;
      if (l[1] === "D" || l[0] === "D") c.deleted = true;
    }
  }
  const stat = git(["diff", "HEAD", "--numstat"], path).stdout.split("\n").filter(Boolean);
  const added = stat.reduce((n, l) => n + (Number(l.split("\t")[0]) || 0), 0);
  const deleted = stat.reduce((n, l) => n + (Number(l.split("\t")[1]) || 0), 0);
  return { ...c, diff: { added, deleted } };
}

const cmd = argv.shift();
const prs = process.env.FAKE_WT_PRS ? JSON.parse(readFileSync(process.env.FAKE_WT_PRS, "utf8")) : {};

if (cmd === "list") {
  const full = has("--full");
  const wts = worktrees();
  const main = wts[0];
  const items = wts.map((w) => {
    const item = {
      branch: w.branch,
      head: { sha: w.head, short_sha: w.head.slice(0, 7), subject: "msg", committed_at: null },
      worktree: { path: w.path, main: w === main, current: w.path === dir, previous: false, detached: !w.branch, changes: changes(w.path) },
      display: { state: w === main ? "is_main" : undefined },
    };
    if (w !== main && w.branch) {
      const [behind, ahead] = git(["rev-list", "--left-right", "--count", `${main.branch}...${w.branch}`]).stdout.trim().split(/\s+/).map(Number);
      item.default_branch = { ahead, behind };
      if (ahead === 0 && behind === 0) item.display.state = "empty";
      else if (ahead === 0) item.display.state = "integrated";
      else item.display.state = behind ? "diverged" : "ahead";
    }
    const pr = full && w.branch && prs[w.branch];
    if (pr) {
      item.pr = { number: pr.number, url: pr.url, review: pr.review, mergeable: pr.mergeable ?? null };
      item.checks = pr.status ? { status: pr.status, source: "pr", stale: false } : undefined;
    }
    return item;
  });
  if (has("--branches")) {
    const taken = new Set(wts.map((w) => w.branch));
    const branches = git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).stdout.split("\n").filter(Boolean);
    for (const b of branches) {
      if (taken.has(b)) continue;
      const [behind, ahead] = git(["rev-list", "--left-right", "--count", `${main.branch}...${b}`]).stdout.trim().split(/\s+/).map(Number);
      items.push({ branch: b, head: { short_sha: "abc1234" }, default_branch: { ahead, behind }, display: { state: ahead ? "ahead" : "empty" } });
    }
  }
  process.stdout.write(JSON.stringify({ schema: 2, repo: { default_branch: main.branch }, collected: { ci: full, summary: false }, items }));
} else if (cmd === "switch") {
  const create = has("--create");
  has("--no-cd");
  has("--format=json");
  const base = take("--base");
  let target = argv.shift();
  const main = worktrees()[0];
  if (/^pr:\d+$/.test(target)) {
    const entry = Object.entries(prs).find(([, p]) => `pr:${p.number}` === target);
    if (!entry) {
      process.stderr.write(`no such PR ${target}\n`);
      process.exit(1);
    }
    target = entry[0];
  }
  process.stderr.write(`(fake wt) switching to ${target}\n`);
  const existing = worktrees().find((w) => w.branch === target);
  if (existing) {
    process.stdout.write(JSON.stringify({ action: "existing", branch: target, path: existing.path }) + "\n");
    process.exit(0);
  }
  const path = join(dirname(main.path), `${basename(main.path)}.${target.replace(/\//g, "-")}`);
  const exists = git(["rev-parse", "--verify", "--quiet", `refs/heads/${target}`], main.path, true).status === 0;
  if (create && exists) {
    process.stderr.write(`branch ${target} already exists\n`);
    process.exit(1);
  }
  if (!create && !exists) {
    process.stderr.write(`branch ${target} not found, use --create\n`);
    process.exit(1);
  }
  if (create) git(["worktree", "add", "-q", "-b", target, path, base ?? main.branch], main.path);
  else git(["worktree", "add", "-q", path, target], main.path);
  process.stdout.write(
    JSON.stringify({ action: "created", branch: target, path, created_branch: create, base_branch: create ? (base ?? main.branch) : undefined }) + "\n",
  );
} else if (cmd === "remove") {
  const force = has("--force");
  const forceDelete = has("--force-delete");
  const keep = has("--no-delete-branch");
  has("--foreground");
  has("--format=json");
  const target = argv.shift();
  const w = worktrees().find((x) => x.branch === target || x.path === target);
  if (!w) {
    process.stderr.write(`no worktree ${target}\n`);
    process.exit(1);
  }
  const main = worktrees()[0];
  const r = git(["worktree", "remove", ...(force ? ["--force"] : []), w.path], main.path, true);
  if (r.status !== 0) {
    process.stderr.write(`✗ ${target} has uncommitted changes; use --force\n`);
    process.exit(1);
  }
  let outcome = "not_attempted";
  if (!keep && w.branch) {
    const d = git(["branch", forceDelete ? "-D" : "-d", w.branch], main.path, true);
    outcome = d.status === 0 ? "deleted" : "retained_unmerged";
  }
  process.stdout.write(JSON.stringify({ kind: "worktree", branch: w.branch, path: w.path, branch_outcome: outcome }) + "\n");
} else {
  process.stderr.write(`fake wt: unsupported ${cmd}\n`);
  process.exit(2);
}
