// Icon sets. "nerd" needs a Nerd Font (v3) in the terminal; "unicode" works anywhere.
// Nerd glyphs are written as escapes so the source stays readable without the font.
import { loadConfig } from "./config.mjs";

export const ICONS = {
  nerd: {
    branch: "\uf418", //  nf-oct-git_branch
    detached: "\uf417", //  nf-oct-git_commit
    prPrefix: "\uf407 ", //  nf-oct-git_pull_request
    passed: "\uf058", //  nf-fa-check_circle
    running: "\uf017", //  nf-fa-clock_o
    failed: "\uf057", //  nf-fa-times_circle
    conflicts: "\uf071", //  nf-fa-warning
    noChecks: "\uf111", //  nf-fa-circle
    approved: "\uf164", //  nf-fa-thumbs_up
    changesRequested: "\uf06a", //  nf-fa-exclamation_circle
    reviewRequested: "\uf06e", //  nf-fa-eye
    draft: "\uf040", //  nf-fa-pencil
    dirty: "\uf111", //  nf-fa-circle
    clean: "\uf00c", //  nf-fa-check
    merged: "\uf419", //  nf-oct-git_merge
    ahead: "\uf062", //  nf-fa-arrow_up
    behind: "\uf063", //  nf-fa-arrow_down
    unpushed: "\uf0ee", //  nf-fa-cloud_upload
    unpulled: "\uf0ed", //  nf-fa-cloud_download
    primary: "\uf015", //  nf-fa-home
    current: "\uf124", //  nf-fa-location_arrow
    other: " ",
    branchOnly: "\uf126", // nf-fa-code_fork
    space: "\uf2d0", //  nf-fa-window_maximize
    panes: "\uf120", //  nf-fa-terminal
    loading: "\uf021", //  nf-fa-refresh
  },
  unicode: {
    branch: "",
    detached: "",
    prPrefix: "#",
    passed: "✓",
    running: "◷",
    failed: "✗",
    conflicts: "⚠",
    noChecks: "·",
    approved: "",
    changesRequested: "",
    reviewRequested: "",
    draft: "",
    dirty: "●",
    clean: "✓",
    merged: "✓",
    ahead: "↑",
    behind: "↓",
    unpushed: "⇡",
    unpulled: "⇣",
    primary: "^",
    current: "@",
    other: "+",
    branchOnly: "/",
    space: "◆",
    panes: "◇",
    loading: "◷",
  },
};

let cached;
/** The configured set; `config.json` "icons": "nerd" (default) or "unicode". */
export function icons(name) {
  if (name) return ICONS[name] ?? ICONS.nerd;
  return (cached ??= ICONS[loadConfig().icons] ?? ICONS.nerd);
}

/** Icon followed by a space, or nothing when the set has no icon for it. */
export const lead = (glyph) => (glyph ? `${glyph} ` : "");
