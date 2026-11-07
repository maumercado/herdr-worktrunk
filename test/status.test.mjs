import { test } from "node:test";
import assert from "node:assert/strict";
import { describe as describeWith } from "../src/status.mjs";
import { ICONS } from "../src/icons.mjs";

const describe = (item) => describeWith(item, ICONS.unicode);
const nerd = (item) => describeWith(item, ICONS.nerd);
import { normalizeList, prRefFromUrl } from "../src/wt.mjs";

const clean = { staged: false, modified: false, untracked: false, renamed: false, deleted: false, conflicted: false };
const item = (extra = {}) => ({ branch: "x", worktree: { path: "/r.x", main: false, changes: clean }, ...extra });

test("open PR with passing checks and approval", () => {
  const d = describe(item({ pr: { number: 42, review: "approved", url: "u" }, checks: { status: "passed" } }));
  assert.equal(d.kind, "pr");
  assert.equal(d.text, "#42 ✓ approved");
  assert.equal(d.tokens.wt_ci, "passed");
  assert.equal(d.tokens.wt_pr, "#42");
  assert.equal(d.tone, "good");
});

test("open PR with failing checks keeps both facts", () => {
  const d = describe(item({ pr: { number: 7, review: "changes_requested" }, checks: { status: "failed" } }));
  assert.equal(d.text, "#7 ✗ failed · changes req");
  assert.equal(d.tone, "bad");
});

test("PR with merge conflicts and no checks status", () => {
  const d = describe(item({ pr: { number: 3, mergeable: false }, checks: { status: null } }));
  assert.equal(d.tokens.wt_ci, "conflicts");
  assert.match(d.text, /^#3 ⚠ conflicts/);
});

test("PR on a dirty checkout gets a dot", () => {
  const d = describe(item({ pr: { number: 9 }, checks: { status: "running" }, worktree: { path: "/p", changes: { ...clean, modified: true } } }));
  assert.equal(d.text, "#9 ◷ running ●");
});

test("no PR: dirty with diff counts", () => {
  const d = describe(item({ worktree: { path: "/p", changes: { ...clean, modified: true, untracked: true, diff: { added: 5, deleted: 2 } } } }));
  assert.equal(d.kind, "dirty");
  assert.equal(d.text, "● dirty !? +5 -2");
  assert.equal(d.tokens.wt_pr, null);
});

test("no PR: clean with ahead/behind and unpushed", () => {
  const d = describe(item({ default_branch: { ahead: 2, behind: 1 }, upstream: { ahead: 1, behind: 0 } }));
  assert.equal(d.text, "✓ clean ↑2 ↓1 ⇡1");
});

test("integrated branch reads as safe to remove", () => {
  const d = describe(item({ display: { state: "integrated" } }));
  assert.equal(d.kind, "merged");
});

test("forge fetch error (pr null) falls back to branch state", () => {
  const d = describe(item({ pr: null, checks: null }));
  assert.equal(d.kind, "clean");
});

test("schema 1 arrays are normalized", () => {
  const list = normalizeList([
    { branch: "main", path: "/r", kind: "worktree", is_main: true, working_tree: clean },
    { branch: "f", path: "/r.f", kind: "worktree", working_tree: { ...clean, staged: true }, ci: { number: 5, status: "passed", review_state: "approved" } },
  ]);
  assert.equal(list.items[1].pr.number, 5);
  assert.equal(describe(list.items[1]).text, "#5 ✓ approved ●");
});

test("PR URL parsing", () => {
  assert.equal(prRefFromUrl("https://github.com/a/b/pull/123/files"), "pr:123");
  assert.equal(prRefFromUrl("https://github.com/a/b/issues/1"), null);
});

test("nerd font set: PR, review and check glyphs, words kept for color rules", () => {
  const d = nerd(item({ pr: { number: 42, review: "approved" }, checks: { status: "passed" } }));
  assert.equal(d.text, "\uf407 42 \uf058 \uf164 approved");
  assert.equal(d.tokens.wt_pr, "#42", "plain token stays icon free");

  const f = nerd(item({ pr: { number: 7, review: "changes_requested" }, checks: { status: "failed" } }));
  assert.equal(f.text, "\uf407 7 \uf057 failed · \uf06a changes req");
});

test("nerd font set: dirty, clean, merged and sync arrows", () => {
  const dirty = nerd(item({ worktree: { path: "/p", changes: { ...clean, modified: true } }, default_branch: { ahead: 2, behind: 0 } }));
  assert.equal(dirty.text, "\uf111 dirty ! \uf0622");
  assert.equal(nerd(item()).text, "\uf00c clean");
  assert.equal(nerd(item({ display: { state: "integrated" } })).text, "\uf419 merged, safe to remove");
});

test("icons default to the nerd set when no config says otherwise", async () => {
  const { icons } = await import("../src/icons.mjs");
  delete process.env.HERDR_PLUGIN_CONFIG_DIR;
  assert.equal(icons(), ICONS.nerd);
});
