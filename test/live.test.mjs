import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setup, MAIN } from "./helpers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, { timeout = 5_000, step = 50, what = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return { value: v, ms: Date.now() - start };
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(step);
  }
}

function startLive(fx, extraEnv = {}) {
  const child = spawn("node", [MAIN, "live"], {
    env: {
      ...process.env,
      ...fx.env,
      HERDR_SOCKET_PATH: join(fx.root, "no-such.sock"),
      WT_HERDR_LIVE_RECONCILE_MS: "300",
      WT_HERDR_LIVE_POLL_MS: "300",
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.exited = new Promise((r) => child.on("exit", (code) => r(code)));
  return child;
}

const tokens = (fx) => Object.fromEntries(fx.state().workspaces.map((w) => [w.workspace_id, w.tokens ?? {}]));
const writeState = (fx, s) => writeFileSync(fx.env.FAKE_HERDR_STATE, JSON.stringify(s));

test("live: a file edit shows up in the sidebar within a second", async () => {
  const fx = setup();
  const child = startLive(fx);
  try {
    await until(() => tokens(fx).w1.wt_kind === "clean" && tokens(fx).w2.wt_kind === "pr", { what: "initial tokens" });
    assert.equal(tokens(fx).w1.wt_head, "main");

    writeFileSync(join(fx.repo, "README.md"), "edited\n");
    const { ms } = await until(() => tokens(fx).w1.wt_kind === "dirty", { what: "dirty after edit" });
    assert.ok(ms < 1_500, `took ${ms} ms`);

    // Undo the edit: back to clean, no event hook involved.
    execFileSync("git", ["-C", fx.repo, "checkout", "--", "README.md"]);
    await until(() => tokens(fx).w1.wt_kind === "clean", { what: "clean after revert" });
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
});

test("live: PR facts survive local refreshes, and a commit updates ahead count", async () => {
  const fx = setup();
  const child = startLive(fx);
  try {
    await until(() => tokens(fx).w2.wt_status === "#42 ✓ approved", { what: "PR status" });
    writeFileSync(join(fx.prPath, "a.txt"), "changed\n");
    await until(() => tokens(fx).w2.wt_status === "#42 ✓ approved ●", { what: "PR + dirty dot" });
    assert.equal(tokens(fx).w2.wt_kind, "pr");

    execFileSync("git", ["-C", fx.prPath, "commit", "-qam", "more"]);
    await until(() => tokens(fx).w2.wt_sync === "↑2", { what: "ahead 2 after commit" });
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
});

test("live: sync hooks stand down while the watcher runs, and one watcher at a time", async () => {
  const fx = setup();
  const child = startLive(fx);
  try {
    await until(() => existsSync(join(fx.env.HERDR_PLUGIN_STATE_DIR, "live.json")), { what: "live.json" });
    await until(() => tokens(fx).w1.wt_kind, { what: "initial tokens" });

    // Separate log, so the watcher's own calls do not count.
    const hookLog = join(fx.root, "hook.log");
    writeFileSync(hookLog, "");
    execFileSync("node", [MAIN, "sync"], { env: { ...process.env, ...fx.env, FAKE_HERDR_LOG: hookLog } });
    assert.equal(readFileSync(hookLog, "utf8"), "", "hook sync should exit without calling herdr");
    // --force (the refresh action) still runs.
    execFileSync("node", [MAIN, "sync", "--force"], { env: { ...process.env, ...fx.env, FAKE_HERDR_LOG: hookLog } });
    assert.notEqual(readFileSync(hookLog, "utf8"), "");

    const second = startLive(fx);
    const code = await Promise.race([second.exited, sleep(3_000).then(() => "still running")]);
    assert.equal(code, 0);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
  assert.equal(existsSync(join(fx.env.HERDR_PLUGIN_STATE_DIR, "live.json")), false, "cleans up on exit");
});

test("live: Herdr socket events pick up a new Space at once, and socket close stops the watcher", async () => {
  const fx = setup();
  const sockPath = join(fx.root, "herdr.sock");
  let client;
  let request;
  const server = createServer((c) => {
    client = c;
    c.setEncoding("utf8");
    c.once("data", (line) => {
      request = JSON.parse(line.trim());
      c.write(`${JSON.stringify({ id: request.id, result: { type: "subscribed" } })}\n`);
    });
  });
  await new Promise((r) => server.listen(sockPath, r));
  // Polling is slowed right down, so only the event can explain a quick update.
  const child = startLive(fx, { HERDR_SOCKET_PATH: sockPath, WT_HERDR_LIVE_RECONCILE_MS: "60000" });
  try {
    await until(() => request, { what: "subscribe request" });
    assert.equal(request.method, "events.subscribe");
    assert.ok(request.params.subscriptions.some((s) => s.type === "workspace.created"));
    await until(() => tokens(fx).w3.wt_kind === "dirty" && tokens(fx).w2.wt_kind === "pr", { what: "initial tokens" });
    await sleep(300);

    const s = fx.state();
    s.workspaces.push({ workspace_id: "w9", number: 9, label: "merged", focused: false, pane_count: 1, tab_count: 1 });
    s.panes.push({ pane_id: "w9:p1", workspace_id: "w9", tab_id: "w9:t1", focused: false, cwd: fx.mergedPath });
    writeState(fx, s);
    client.write(`${JSON.stringify({ event: { type: "workspace.created", workspace_id: "w9" } })}\n`);

    // Generous bound for loaded CI machines; polling alone would take 60 s here.
    const { ms } = await until(() => tokens(fx).w9?.wt_kind === "merged", { what: "tokens on new Space" });
    assert.ok(ms < 3_000, `took ${ms} ms`);
    assert.equal(tokens(fx).w9.wt_branch, "feat-merged");

    client.end();
    const code = await Promise.race([child.exited, sleep(3_000).then(() => "still running")]);
    assert.equal(code, 0, "watcher exits when Herdr closes the socket");
  } finally {
    child.kill("SIGTERM");
    server.close();
  }
});

test("live: tokens are only sent when they change", async () => {
  const fx = setup();
  const child = startLive(fx);
  try {
    await until(() => tokens(fx).w2.wt_kind === "pr", { what: "initial tokens" });
    await sleep(500);
    fx.clearCalls();
    await sleep(1_000); // several reconcile ticks with nothing changing
    assert.equal(fx.calls().filter((c) => c[1] === "report-metadata").length, 0);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
});

test('live: "live": false runs one sync and exits', async () => {
  const fx = setup();
  const cfg = join(fx.env.HERDR_PLUGIN_CONFIG_DIR, "config.json");
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, "utf8")), live: false }));
  const child = startLive(fx);
  const code = await Promise.race([child.exited, sleep(5_000).then(() => "still running")]);
  assert.equal(code, 0);
  assert.equal(tokens(fx).w2.wt_kind, "pr");
});
