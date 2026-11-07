// Turn one `wt list` item into a short status for the sidebar and the picker.
// Status text always keeps a plain word (failed, running, dirty...) next to the
// icon so sidebar color rules can match on it in either icon set.
import { icons, lead } from "./icons.mjs";

const CI = {
  passed: { icon: "passed", word: "passed", tone: "good" },
  running: { icon: "running", word: "running", tone: "busy" },
  failed: { icon: "failed", word: "failed", tone: "bad" },
  conflicts: { icon: "conflicts", word: "conflicts", tone: "bad" },
  error: { icon: "noChecks", word: "ci unknown", tone: "muted" },
  none: { icon: "noChecks", word: "no checks", tone: "muted" },
};

const REVIEW = {
  approved: { word: "approved", icon: "approved" },
  changes_requested: { word: "changes req", icon: "changesRequested" },
  pending: { word: "review req", icon: "reviewRequested" },
  draft: { word: "draft", icon: "draft" },
};

export function changeFlags(item) {
  const c = item.worktree?.changes;
  if (!c) return null;
  return {
    staged: !!c.staged,
    modified: !!c.modified || !!c.renamed || !!c.deleted,
    untracked: !!c.untracked,
    conflicted: !!c.conflicted,
    added: c.diff?.added ?? 0,
    deleted: c.diff?.deleted ?? 0,
  };
}

export function isDirty(item) {
  const f = changeFlags(item);
  return !!f && (f.staged || f.modified || f.untracked || f.conflicted);
}

function ciOf(item) {
  if (!item.pr) return null;
  if (item.pr.mergeable === false && !item.checks?.status) return "conflicts";
  if (item.checks?.status) return item.checks.status;
  if (item.pr.number === null && item.checks === null) return "error";
  return "none";
}

function syncText(item, I) {
  const parts = [];
  const ahead = item.default_branch?.ahead ?? 0;
  const behind = item.default_branch?.behind ?? 0;
  if (ahead) parts.push(`${I.ahead}${ahead}`);
  if (behind) parts.push(`${I.behind}${behind}`);
  if (item.upstream?.ahead) parts.push(`${I.unpushed}${item.upstream.ahead}`);
  if (item.upstream?.behind) parts.push(`${I.unpulled}${item.upstream.behind}`);
  return parts.join(" ");
}

/**
 * kind: "pr" when the branch has an open PR, else "dirty" | "merged" | "clean".
 * text: compact line that fits a ~30 column sidebar.
 */
export function describe(item, I = icons()) {
  const dirty = isDirty(item);
  const sync = syncText(item, I);
  const ci = ciOf(item);

  if (item.pr && ci !== "error") {
    const ciInfo = CI[ci] ?? CI.none;
    const ciIcon = I[ciInfo.icon];
    const rev = REVIEW[item.pr.review];
    const review = rev ? `${lead(I[rev.icon])}${rev.word}` : "";
    const num = item.pr.number ? `#${item.pr.number}` : "PR";
    const label = item.pr.number ? `${I.prPrefix}${item.pr.number}` : "PR";
    let text = `${label} ${ciIcon} ${review || ciInfo.word}`;
    if (review && ci !== "none" && ci !== "passed") text = `${label} ${ciIcon} ${ciInfo.word} · ${review}`;
    if (dirty) text += ` ${I.dirty}`;
    if (item.checks?.stale) text += ` ${I.unpushed}`;
    return {
      kind: "pr",
      tone: ci === "passed" && item.pr.review === "changes_requested" ? "bad" : ciInfo.tone,
      text,
      tokens: {
        wt_status: text,
        wt_kind: "pr",
        wt_pr: num,
        wt_ci: ci,
        wt_review: item.pr.review ?? null,
        wt_sync: sync || null,
        wt_url: item.pr.url ?? null,
      },
    };
  }

  const f = changeFlags(item);
  let kind = "clean";
  let text;
  if (dirty) {
    kind = "dirty";
    const marks = [f.conflicted && "✘", f.staged && "+", f.modified && "!", f.untracked && "?"].filter(Boolean).join("");
    const diff = f.added || f.deleted ? ` +${f.added} -${f.deleted}` : "";
    text = `${I.dirty} dirty ${marks}${diff}`;
  } else if (!item.worktree?.main && ["integrated", "empty"].includes(item.display?.state)) {
    kind = "merged";
    // Branch rows with no checkout have nothing to remove.
    text = item.worktree ? `${I.merged} merged, safe to remove` : `${I.merged} merged`;
  } else {
    text = `${I.clean} clean`;
  }
  if (sync && kind !== "merged") text += ` ${sync}`;
  return {
    kind,
    tone: kind === "dirty" ? "warn" : kind === "merged" ? "muted" : "good",
    text,
    tokens: {
      wt_status: text,
      wt_kind: kind,
      wt_pr: null,
      wt_ci: null,
      wt_review: null,
      wt_sync: sync || null,
      wt_url: null,
    },
  };
}
