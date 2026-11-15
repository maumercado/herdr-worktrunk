#!/usr/bin/env node
// Entry point for every manifest command.
//
//   main.mjs picker                 the popup UI (mode from WT_HERDR_MODE)
//   main.mjs open-pane <mode>       action: open the popup in browse | create | remove-current | pr-link
//   main.mjs live                   keep Space tokens in step with git (started by the startup hook)
//   main.mjs sync [--force]         push PR / branch status into Space tokens once
//   main.mjs status [dir]           print what sync would report for one checkout (debugging)
//   main.mjs list --json [dir]      worktrees + status for the Herdr app dialog (and other front ends)
//   main.mjs sidebar-config [file]  print Herdr sidebar rows colored with the active (or given) theme
import { openPluginPane, notify, invocationContext } from "./herdr.mjs";
import { which } from "./exec.mjs";
import { WT, repoOf, wtList } from "./wt.mjs";
import { loadConfig } from "./config.mjs";

const [cmd = "picker", ...rest] = process.argv.slice(2);
const log = (msg) => process.stderr.write(`[worktrunk] ${msg}\n`);

function requireWt() {
  if (which(WT())) return true;
  notify("Worktrunk not found", "Install it (brew install worktrunk) or set WT_HERDR_WT_BIN.");
  log(`${WT()} not found on PATH`);
  return false;
}

async function main() {
  switch (cmd) {
    case "list": {
      // `list --json [dir]` — the app mod calls this so it never reimplements wt.
      const json = rest[0] === "--json";
      if (!json) {
        log("usage: main.mjs list --json [dir]");
        return 2;
      }
      if (!requireWt()) {
        process.stdout.write(`${JSON.stringify({ error: `${WT()} not found on PATH` })}\n`);
        return 1;
      }
      const { listJson } = await import("./list-json.mjs");
      const dir = rest[1] ?? process.cwd();
      const body = listJson(dir);
      process.stdout.write(`${JSON.stringify(body)}\n`);
      return body.error ? 1 : 0;
    }
    case "open-pane": {
      if (!requireWt()) return 1;
      const mode = rest[0] ?? "browse";
      const env = { WT_HERDR_MODE: mode };
      // Popups get the underlying pane's context; pass the clicked URL along explicitly too.
      const url = invocationContext().clickedUrl;
      if (url) env.WT_HERDR_URL = url;
      openPluginPane("picker", env);
      return 0;
    }
    case "picker": {
      if (!requireWt()) return 1;
      const { Picker } = await import("./picker.mjs");
      const picker = new Picker({ mode: process.env.WT_HERDR_MODE || "browse" });
      if (process.env.WT_HERDR_URL && !picker.ctx.clickedUrl) picker.ctx.clickedUrl = process.env.WT_HERDR_URL;
      await picker.start();
      return null; // the UI decides when to exit
    }
    case "live": {
      if (!which(WT())) return 0;
      const { syncStatus } = await import("./sync.mjs");
      if (loadConfig().live === false) {
        // Live updates turned off: one sync per server start, like the hooks.
        syncStatus({ force: true, log });
        return 0;
      }
      const { runLive } = await import("./live.mjs");
      return runLive({ log: process.env.WT_HERDR_DEBUG ? log : () => {} });
    }
    case "sync": {
      if (!which(WT())) return 0; // stay quiet in hooks
      // The live watcher already follows every change; hooks have nothing to add.
      const { liveRunning } = await import("./live.mjs");
      if (!rest.includes("--force") && liveRunning()) return 0;
      const { syncStatus } = await import("./sync.mjs");
      const res = syncStatus({ force: rest.includes("--force"), log });
      if (res.errors?.length) log(res.errors.join("\n"));
      return 0;
    }
    case "status": {
      const { describe } = await import("./status.mjs");
      const { itemForPath } = await import("./sync.mjs");
      const repo = repoOf(rest[0] ?? process.cwd());
      if (!repo) {
        log("not a git repository");
        return 1;
      }
      const item = itemForPath(wtList(repo.toplevel, { full: true }).items, repo.toplevel);
      process.stdout.write(`${JSON.stringify(item ? describe(item) : null, null, 2)}\n`);
      return 0;
    }
    case "sidebar-config": {
      // Optional theme file argument, handy when run outside Herdr (no config dir).
      const { sidebarConfig, theme } = await import("./theme.mjs");
      const cfg = rest[0] ? { ...loadConfig(), ohMyPoshTheme: rest[0] } : undefined;
      process.stdout.write(sidebarConfig(theme(cfg)));
      return 0;
    }
    default:
      log(`unknown command: ${cmd}`);
      return 2;
  }
}

main().then(
  (code) => {
    if (code !== null) process.exitCode = code;
  },
  (error) => {
    log(error.stack || String(error));
    if (cmd !== "sync") notify("Worktrunk plugin error", error.message);
    process.exitCode = 1;
  },
);
