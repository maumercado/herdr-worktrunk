import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setup, MAIN } from "./helpers.mjs";

const runMain = (fx, args, extraEnv = {}) =>
  execFileSync("node", [MAIN, ...args], { env: { ...process.env, ...fx.env, ...extraEnv }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("sync reports PR state, dirty state and clean state as Space tokens", () => {
  const fx = setup();
  runMain(fx, ["sync", "--force"]);
  const ws = Object.fromEntries(fx.state().workspaces.map((w) => [w.workspace_id, w.tokens ?? {}]));

  assert.equal(ws.w1.wt_kind, "clean");
  assert.equal(ws.w1.wt_branch, "main");

  assert.equal(ws.w2.wt_kind, "pr");
  assert.equal(ws.w2.wt_status, "#42 ✓ approved");
  assert.equal(ws.w2.wt_ci, "passed");
  assert.equal(ws.w2.wt_url, "https://github.com/acme/app/pull/42");

  // w3 has no worktree provenance; found through its pane cwd.
  assert.equal(ws.w3.wt_kind, "dirty");
  assert.match(ws.w3.wt_status, /^● dirty !\?/);
  assert.equal(ws.w3.wt_branch, "feat-dirty");

  const reports = fx.calls().filter((c) => c[0] === "workspace" && c[1] === "report-metadata");
  assert.equal(reports.length, 3);
  for (const r of reports) {
    assert.equal(r[r.indexOf("--source") + 1], "plugin:maumercado.worktrunk");
    assert.ok(Number(r[r.indexOf("--seq") + 1]) > 0);
  }
  // A clean, PR-less Space clears PR tokens instead of leaving stale ones.
  const w1 = reports.find((r) => r[2] === "w1");
  assert.ok(w1.includes("--clear-token") && w1[w1.indexOf("--clear-token") + 1] === "wt_pr");
});

test("wt list --full runs once per repo, with summaries disabled", () => {
  const fx = setup();
  const log = `${fx.root}/wt.log`;
  runMain(fx, ["sync", "--force"], { FAKE_WT_LOG: log });
  const calls = execFileSync("cat", [log], { encoding: "utf8" }).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("--full"));
  assert.ok(calls[0].includes("list.summary=false"));
});

test("hook bursts are throttled, but a brand-new Space is synced right away", () => {
  const fx = setup();
  runMain(fx, ["sync"]);
  fx.clearCalls();
  runMain(fx, ["sync"]);
  assert.equal(fx.calls().filter((c) => c[1] === "report-metadata").length, 0, "second run should be throttled");

  // Simulate a new Space appearing (e.g. worktree.opened).
  const s = fx.state();
  s.workspaces.push({ ...s.workspaces[1], workspace_id: "w9", number: 9 });
  execFileSync("node", ["-e", `require('fs').writeFileSync(${JSON.stringify(fx.env.FAKE_HERDR_STATE)}, ${JSON.stringify(JSON.stringify(s))})`]);
  runMain(fx, ["sync"]);
  assert.ok(fx.calls().some((c) => c[1] === "report-metadata" && c[2] === "w9"));
});

test("--force ignores the throttle", () => {
  const fx = setup();
  runMain(fx, ["sync"]);
  fx.clearCalls();
  runMain(fx, ["sync", "--force"]);
  assert.equal(fx.calls().filter((c) => c[1] === "report-metadata").length, 3);
});

test("sync is silent when wt is missing", () => {
  const fx = setup();
  const out = runMain(fx, ["sync", "--force"], { WT_HERDR_WT_BIN: "/nonexistent/wt" });
  assert.equal(out, "");
  assert.equal(fx.calls().length, 0);
});
