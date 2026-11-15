import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setup, MAIN, FAKE_WT } from "./helpers.mjs";
import { listJson } from "../src/list-json.mjs";

test("listJson returns worktrees with describe status", () => {
  const fx = setup();
  process.env.WT_HERDR_WT_BIN = FAKE_WT;
  process.env.FAKE_WT_PRS = `${fx.root}/prs.json`;
  process.env.HERDR_PLUGIN_CONFIG_DIR = `${fx.root}/plugin-config`;
  const body = listJson(fx.repo);
  assert.equal(body.error, undefined);
  assert.equal(body.repo.toplevel, fx.repo);
  assert.ok(body.worktrees.length >= 3);
  const pr = body.worktrees.find((w) => w.branch === "feat-pr");
  assert.ok(pr);
  assert.equal(pr.pr, 42);
  assert.equal(pr.kind, "pr");
  assert.match(pr.status, /#42/);
  const dirty = body.worktrees.find((w) => w.branch === "feat-dirty");
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.kind, "dirty");
});

test("listJson outside a repo returns an error object", () => {
  const body = listJson("/tmp");
  assert.equal(body.error, "not a git repository");
});

test("main.mjs list --json prints the same shape", () => {
  const fx = setup();
  const res = spawnSync(process.execPath, [MAIN, "list", "--json", fx.repo], {
    encoding: "utf8",
    env: { ...process.env, ...fx.env },
  });
  assert.equal(res.status, 0, res.stderr);
  const body = JSON.parse(res.stdout);
  assert.ok(Array.isArray(body.worktrees));
  assert.ok(body.worktrees.some((w) => w.branch === "main" && w.main));
});

test("main.mjs list without --json exits 2", () => {
  const res = spawnSync(process.execPath, [MAIN, "list"], { encoding: "utf8" });
  assert.equal(res.status, 2);
});
