# herdr-worktrunk

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Herdr](https://img.shields.io/badge/herdr-%E2%89%A50.9.2-8a5cf6)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux-lightgrey)

A [Herdr](https://herdr.dev) plugin that drives your git worktrees through [Worktrunk](https://worktrunk.dev) (`wt`).

Browse, create, open and remove worktrees from a popup, and see each worktree's PR or branch state right in the Herdr sidebar. Creation and removal go through `wt`, so your `worktree-path` template, project hooks and branch cleanup behave the same as they do on the command line.

## Contents

* [Features](#features)
* [Requirements](#requirements)
* [Install](#install)
* [Quick start](#quick-start)
* [The popup](#the-popup)
* [Status in the sidebar](#status-in-the-sidebar)
* [Configuration](#configuration)
* [How it maps to Herdr](#how-it-maps-to-herdr)
* [Troubleshooting](#troubleshooting)
* [Development](#development)
* [License](#license)

## Features

* **One popup for every worktree** of the current repo, with its state. Open any of them as a **Space**, a **tab** in the current Space, or a **split** next to the focused pane.
* **Create and open in one step**: a new branch, an existing branch, or a PR. `wt switch` does the work, so Worktrunk hooks run as usual.
* **Clean removal**: `wt remove` handles the branch (`--force`, `-D`, keep), then the plugin closes the Herdr Spaces and panes that were sitting in that checkout.
* **Sidebar status per Space**: PR number, checks and review when the branch has an open PR; otherwise dirty or clean plus ahead/behind.
* **Ctrl-click a GitHub PR link** in any pane to check it out in a worktree.
* **Nerd Font icons** for branches, PRs, checks and reviews, with a plain Unicode fallback.
* **No build step and no dependencies**: plain Node ES modules.

## Requirements

| Tool | Version | Why |
|---|---|---|
| [Herdr](https://herdr.dev) | 0.9.2 or newer | host app |
| [Worktrunk](https://worktrunk.dev) (`wt`) | tested with 0.81.0 | creates, lists and removes worktrees |
| Node.js | 20 or newer | runs the plugin |
| [`gh`](https://cli.github.com) | logged in | optional, for PR status (`wt list --full` uses it) |

`wt` and `node` need to be on the `PATH` that Herdr's server sees. If `wt` is not, set `wtBin` in the [config](#configuration).

## Install

From GitHub:

```sh
herdr plugin install maumercado/herdr-worktrunk
```

Or from a local checkout, handy while hacking on it:

```sh
git clone https://github.com/maumercado/herdr-worktrunk.git
herdr plugin link ./herdr-worktrunk
```

## Quick start

Add keybindings to `~/.config/herdr/config.toml` (pick any free keys):

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "maumercado.worktrunk.picker"
description = "worktrees"

[[keys.command]]
key = "prefix+shift+a"
type = "plugin_action"
command = "maumercado.worktrunk.new"
description = "new worktree"

[[keys.command]]
key = "prefix+u"
type = "plugin_action"
command = "maumercado.worktrunk.refresh"
description = "refresh worktree status"
```

Then, from any pane inside a git repo, press `prefix+a` to open the popup.

### Actions

| Action | Does |
|---|---|
| `maumercado.worktrunk.picker` | open the popup in browse mode |
| `maumercado.worktrunk.new` | open the popup straight into "new worktree" |
| `maumercado.worktrunk.remove` | remove the worktree of the focused pane |
| `maumercado.worktrunk.refresh` | refresh sidebar status now, ignoring the throttle |
| `maumercado.worktrunk.pr-link` | target of the GitHub PR link handler |

## The popup

| Key | Does |
|---|---|
| `enter` / `s` | open as a Space (reuses the Space if it is already open) |
| `t` | open as a tab in the current Space |
| `v` | split right of the focused pane |
| `-` | split below |
| `n` | new worktree: type a branch, then a base (Enter for the default branch). An existing branch or `pr:123` is checked out instead of created |
| `p` | check out a PR by number or URL |
| `b` | show or hide local branches with no worktree yet; opening one runs `wt switch` to create the checkout first |
| `x` | remove: toggle `f` force, `D` delete unmerged branch, `k` keep branch, `c` close Herdr panes; `y` to run |
| `o` | open the PR in the browser |
| `r` | refresh |
| `/` | filter by branch, path or PR number |
| `q` / `esc` | close |

### Row markers

| Nerd Font | Unicode | Means |
|---|---|---|
| window icon | `◆` | already open as a Space |
| terminal icon | `◇` | some panes sit in this checkout |
| home icon | `^` | the primary worktree |
| arrow icon | `@` | the worktree your focused pane is in |

`wt` runs attached to the popup, so the first time a project hook needs approval you can answer the prompt right there.

Removal runs `wt remove --foreground` first and only closes Herdr Spaces and panes after it succeeds. A dirty worktree is refused unless you toggle force (Worktrunk saves a backup ref before discarding).

## Status in the sidebar

The plugin reports these workspace tokens on every Space that lives inside a repo:

| Token | Example |
|---|---|
| `$wt_status` | `#42 ✓ approved`, `#7 ✗ failed · changes req`, `● dirty !? +12 -3`, `clean ↑2`, `merged, safe to remove` (shown with the Unicode set) |
| `$wt_kind` | `pr`, `dirty`, `clean`, `merged` |
| `$wt_pr` | `#42` |
| `$wt_ci` | `passed`, `running`, `failed`, `conflicts`, `none` |
| `$wt_review` | `approved`, `changes_requested`, `pending`, `draft` |
| `$wt_sync` | `↑2 ↓1 ⇡1` (ahead/behind the default branch, unpushed) |
| `$wt_branch` | branch name |

Show them by replacing the Space rows in `config.toml`:

```toml
[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["branch", { token = "$wt_status", fg = "#a6e3a1", rules = [
    { contains = "failed", fg = "#f38ba8" },
    { contains = "conflicts", fg = "#f38ba8" },
    { contains = "changes req", fg = "#f38ba8" },
    { contains = "running", fg = "#f9e2af" },
    { contains = "review req", fg = "#f9e2af" },
    { contains = "dirty", fg = "#fab387" },
    { contains = "merged", dim = true },
  ] }],
]
```

Status text always keeps a word next to each icon (`failed`, `running`, `dirty`, `merged`), so these color rules work with either icon set. `$wt_pr`, `$wt_ci` and `$wt_review` stay plain text.

### When status refreshes

* On Space focus, Space creation, worktree creation or open, and agent state changes.
* Runs are throttled (8 seconds by default) and serialized with a lock, so a burst of events costs one `wt list --full`.
* A Space the plugin has not seen yet always syncs right away.
* Herdr does not keep tokens across a server restart, so a startup hook fills them again.
* LLM summaries are always off for the plugin's `wt list` calls, so it never spends model tokens.

## Configuration

Everything is optional. Put a `config.json` in the plugin config dir:

```sh
herdr plugin config-dir maumercado.worktrunk
```

```json
{
  "defaultOpen": "space",
  "afterCreate": "ask",
  "closePanesOnRemove": true,
  "showBranches": false,
  "syncThrottleSeconds": 8,
  "icons": "nerd",
  "wtBin": "/opt/homebrew/bin/wt"
}
```

| Key | Default | Values |
|---|---|---|
| `defaultOpen` | `"space"` | what `enter` does: `space`, `tab`, `split`, `split-down` |
| `afterCreate` | `"ask"` | `ask` shows the open menu after creating; or always `space`, `tab`, `split`, `split-down`, `none` |
| `closePanesOnRemove` | `true` | close Herdr Spaces and panes inside a worktree when it is removed |
| `showBranches` | `false` | start the popup with branch rows listed (same as pressing `b`) |
| `syncThrottleSeconds` | `8` | minimum seconds between event-triggered syncs |
| `icons` | `"nerd"` | `nerd` needs a Nerd Font v3 in your terminal; `unicode` works with any font |
| `wtBin` | `null` | absolute path to `wt` when Herdr's server does not have it on `PATH` |

## How it maps to Herdr

| Plugin does | Herdr command |
|---|---|
| Open as Space | `herdr worktree open --cwd <primary> --path <checkout>`: groups the Space under the repo's own Space and returns the existing one if open. Falls back to `workspace create` if Herdr cannot match the checkout |
| Open as tab | `herdr tab create --workspace <current> --cwd <checkout>` |
| Split | `herdr pane split --pane <focused> --cwd <checkout>`, then names the pane after the branch |
| Report status | `herdr workspace report-metadata <id> --source plugin:maumercado.worktrunk --token ...` |

Herdr's built-in `worktree create` and `worktree remove` are not used: creation and removal go through `wt` so Worktrunk's paths, hooks and branch cleanup apply.

## Troubleshooting

* **"Worktrunk not found"**: Herdr's server cannot see `wt`. Set `wtBin` in `config.json` (find the path with `which wt`).
* **No PR info in the sidebar**: check `gh auth status`. Worktrunk needs `gh` to fetch PR state.
* **Status looks stale**: press your `refresh` key (the `maumercado.worktrunk.refresh` action ignores the throttle).
* **Inspect what sync would report** for a checkout:

  ```sh
  node src/main.mjs status /path/to/worktree
  ```

* **Command logs**:

  ```sh
  herdr plugin log list --plugin maumercado.worktrunk
  ```

## Development

```sh
git clone https://github.com/maumercado/herdr-worktrunk.git
cd herdr-worktrunk
herdr plugin link .
npm test
```

There is no build step and no `npm install`; the plugin only uses Node built-ins.

### Layout

```
herdr-plugin.toml   manifest: actions, popup pane, event hooks, link handler
src/
  main.mjs          entry point for every manifest command
  picker.mjs        the popup UI
  tui.mjs           minimal terminal UI helpers
  wt.mjs            Worktrunk wrapper (wt list / switch / remove)
  herdr.mjs         Herdr CLI wrapper and invocation context
  sync.mjs          throttled status sync into Space tokens
  status.mjs        turns a wt list item into sidebar tokens
  icons.mjs         Nerd Font and Unicode icon sets
  config.mjs        config.json loading and defaults
  exec.mjs          process helpers
test/
  fakes/            stand-ins for herdr and wt
  *.test.mjs        node:test suites
```

### Tests

Tests run against real git worktrees, with stand-ins for `herdr` and `wt` in `test/fakes/` that emit the JSON shapes from Herdr 0.9.5 (`src/api/schema`) and Worktrunk 0.81.0 (`wt list` schema 2, `wt switch` and `wt remove --format=json`).

### Environment overrides

| Variable | Use |
|---|---|
| `WT_HERDR_WT_BIN` | path to `wt` (same as `wtBin`) |
| `WT_HERDR_THROTTLE_MS` | sync throttle in milliseconds |

## License

[MIT](LICENSE) © Mauricio Mercado
