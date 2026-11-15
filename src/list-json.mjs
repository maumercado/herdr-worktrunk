// Shape `wt list` + describe into one JSON document for front ends (the Herdr
// app mod). Unicode icons so the text is stable without a Nerd Font.
import { repoOf, wtList, worktreeItems } from "./wt.mjs";
import { describe, isDirty } from "./status.mjs";
import { ICONS } from "./icons.mjs";

/**
 * List the worktrees of the repo that `dir` belongs to.
 * Returns `{ repo, worktrees }` or `{ error, dir? }`.
 */
export function listJson(dir, { full = true } = {}) {
  const repo = repoOf(dir);
  if (!repo) return { error: "not a git repository", dir: dir ?? null };
  let list;
  try {
    list = wtList(repo.toplevel, { full });
  } catch (error) {
    return { error: error.message || String(error), dir: repo.toplevel };
  }
  const I = ICONS.unicode;
  return {
    repo: {
      toplevel: repo.toplevel,
      commonDir: repo.commonDir,
      defaultBranch: list.defaultBranch,
      forgeUrl: list.forgeUrl ?? null,
    },
    worktrees: worktreeItems(list).map((item) => {
      const d = describe(item, I);
      return {
        branch: item.branch ?? null,
        path: item.worktree.path,
        main: !!item.worktree.main,
        current: !!item.worktree.current,
        detached: !!item.worktree.detached,
        dirty: isDirty(item),
        kind: d.kind,
        tone: d.tone,
        status: d.text,
        pr: item.pr?.number ?? null,
        prUrl: item.pr?.url ?? null,
        review: item.pr?.review ?? null,
        ci: d.tokens.wt_ci,
      };
    }),
  };
}
