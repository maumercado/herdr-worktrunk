#!/usr/bin/env node
// Entry point for every manifest command.
//
//   main.mjs picker                 the popup UI (mode from WT_HERDR_MODE)
//   main.mjs open-pane <mode>       action: open the popup in browse | create | remove-current | pr-link
//   main.mjs sync [--force]         push PR / branch status into Space tokens
//   main.mjs status [dir]           print what sync would report for one checkout (debugging)
import { openPluginPane, notify, invocationContext } from "./herdr.mjs";
import { which } from "./exec.mjs";
import { WT, repoOf, wtList } from "./wt.mjs";

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
    case "sync": {
      if (!which(WT())) return 0; // stay quiet in hooks
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
