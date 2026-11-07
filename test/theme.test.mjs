import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parsePalette, rolesFrom, sgr, hex, theme, sidebarConfig, BUILTIN } from "../src/theme.mjs";
import { headTokens } from "../src/sync.mjs";
import { ICONS } from "../src/icons.mjs";

const POSH_TOML = `"$schema" = "x"
version = 4

[palette]
  on = "#cccccc"
  folder = "lightBlue"
  branch = "#906cff"
  rust = "#ff8700"
  muted = "#767676"
  arrow = "lightGreen"
  took = "#d4a017"
  alias = "p:branch"

[[blocks]]
  foreground = "p:muted"
`;

test("reads [palette] from an oh-my-posh TOML theme and stops at the next table", () => {
  const p = parsePalette(POSH_TOML, "t.toml");
  assert.equal(p.branch, "#906cff");
  assert.equal(p.arrow, "lightGreen");
  assert.equal(p.foreground, undefined);
});

test("reads JSON and YAML themes too", () => {
  assert.equal(parsePalette(JSON.stringify({ palette: { branch: "#123456" } }), "t.json").branch, "#123456");
  assert.equal(parsePalette("palette:\n  branch: '#abcdef'\n  folder: lightBlue\nblocks: []\n", "t.yaml").folder, "lightBlue");
});

test("maps the palette onto roles, following p: references", () => {
  const r = rolesFrom(parsePalette(POSH_TOML, "t.toml"));
  assert.equal(r.branch, "#906cff");
  assert.equal(r.path, "lightBlue");
  assert.equal(r.good, "lightGreen");
  assert.equal(r.warn, "#ff8700");
  assert.equal(r.busy, "#d4a017");
  assert.equal(r.bad, "red");
  assert.equal(r.accent, "#906cff");
  assert.equal(rolesFrom({ git: "p:alias", alias: "#010203" }).branch, "#010203");
  assert.equal(rolesFrom({ branch: "#906cff" }, { branch: "#ffffff" }).branch, "#ffffff");
});

test("hex colors become truecolor, named colors use the terminal's own ANSI palette", () => {
  assert.equal(sgr("#906cff"), "38;2;144;108;255");
  assert.equal(sgr("#fff"), "38;2;255;255;255");
  assert.equal(sgr("lightGreen"), "92");
  assert.equal(sgr("nope"), null);
  assert.equal(hex("#906CFF"), "#906cff");
  assert.equal(hex("lightGreen", { lightGreen: "#00ff00" }), "#00ff00");
});

test("defaults to the built-in mauposh palette, or reads ohMyPoshTheme from config", () => {
  const t = theme({});
  assert.equal(t.roles.branch, BUILTIN.dark.branch);
  assert.equal(t.paint.branch("x"), "\x1b[38;2;144;108;255mx\x1b[39m");
  assert.equal(theme({ appearance: "light" }).roles.branch, BUILTIN.light.branch);

  const dir = mkdtempSync(join(tmpdir(), "posh-"));
  const file = join(dir, "mine.omp.toml");
  writeFileSync(file, POSH_TOML.replace("#906cff", "#00aaff"));
  const mine = theme({ ohMyPoshTheme: file });
  assert.equal(mine.roles.branch, "#00aaff");
  assert.equal(mine.name, file);

  assert.equal(theme({ ohMyPoshTheme: join(dir, "missing.toml") }).name, "built-in mauposh-dark");
  assert.equal(theme({ theme: "ansi" }).paint.good("x"), "\x1b[32mx\x1b[39m");
});

test("sidebar-config colors the branch and status tokens from the theme", () => {
  const out = sidebarConfig(theme({ namedColors: { lightGreen: "#00ff00" } }));
  assert.match(out, /\[ui\.sidebar\.spaces\]/);
  assert.match(out, /token = "\$wt_head", fg = "#906cff"/);
  assert.match(out, /token = "\$wt_status", fg = "#00ff00"/);
  assert.match(out, /contains = "dirty", fg = "#ff8700"/);
  // Herdr only takes #RGB / #RRGGBB in sidebar rows.
  for (const m of out.matchAll(/fg = "([^"]+)"/g)) assert.match(m[1], /^#[0-9a-f]{6}$/);
});

test("wt_head uses the prompt's branch glyph", () => {
  assert.deepEqual(headTokens({ branch: "feat/x" }, ICONS.nerd), { wt_branch: "feat/x", wt_head: " feat/x" });
  assert.deepEqual(headTokens({ branch: "feat/x" }, ICONS.unicode), { wt_branch: "feat/x", wt_head: "feat/x" });
  assert.equal(headTokens({ head: { short_sha: "abc1234" } }, ICONS.nerd).wt_head, " abc1234");
});
