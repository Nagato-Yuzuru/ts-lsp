// End-to-end tests of the launcher against freshly installed upstream releases.
// Each case lays out a project under a temp directory whose path contains a space.
//
// Environment:
//   TS7_SPEC             version spec for the TS 7 cases (default "^7"; CI also runs "next")
//   FIXTURE_RELEASE_AGE  pnpm minimum-release-age in minutes for fixture installs (default 10080 = 7 days)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { launcher, runSession, type SessionResult } from "./lsp-session.ts";

const FIXTURE = fileURLToPath(new URL("fixture", import.meta.url));
const TS7_SPEC = process.env.TS7_SPEC ?? "^7";
const RELEASE_AGE = process.env.FIXTURE_RELEASE_AGE ?? "10080";

let root: string;
let nodeOnlyBin: string; // a PATH entry holding nothing but `node`

function copyFixture(dir: string): string {
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function install(dir: string, devDependencies: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, devDependencies }));
  const r = spawnSync("pnpm", ["install", `--config.minimum-release-age=${RELEASE_AGE}`], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `pnpm install in ${dir} failed:\n${r.stdout}\n${r.stderr}`);
}

function assertWorks(r: SessionResult): void {
  assert.deepEqual(r.definition, ["a.ts:0"]);
  assert.deepEqual(r.references, ["a.ts:0", "b.ts:0", "b.ts:2"]);
  assert.match(r.hover, /greet\(name: string\)/);
  assert.deepEqual([...r.diagnostics].sort(), ["TS2322@2", "TS2345@2"]);
}

describe("launcher", () => {
  before(() => {
    root = mkdtempSync(join(tmpdir(), "ts-lsp smoke-"));
    nodeOnlyBin = join(root, "node-only bin");
    mkdirSync(nodeOnlyBin);
    symlinkSync(process.execPath, join(nodeOnlyBin, "node"));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test("TS 7 project runs tsc --lsp through the diagnostics bridge", async (t) => {
    const project = copyFixture(join(root, "ts7"));
    install(project, { typescript: TS7_SPEC });
    const r = await runSession(project);
    t.diagnostic(r.launcherLog);
    assert.match(r.launcherLog, /project TypeScript 7\.\S+ at .*\/tsc --lsp --stdio \(diagnostics bridged\)/);
    assertWorks(r);
    // Exit status is not asserted: tsc 7.0 exits 1 ("context canceled") after a clean shutdown.
  });

  for (const major of [6, 5]) {
    test(`TS ${major} project runs project-local typescript-language-server`, async (t) => {
      const project = copyFixture(join(root, `ts${major}`));
      install(project, { typescript: `^${major}`, "typescript-language-server": "latest" });
      const r = await runSession(project);
      t.diagnostic(r.launcherLog);
      assert.match(
        r.launcherLog,
        new RegExp(`project TypeScript ${major}\\.\\S+ at .*typescript-language-server.* --stdio`),
      );
      assert.doesNotMatch(r.launcherLog, /bridged/);
      assertWorks(r);
      assert.equal(r.exitCode, 0);
    });
  }

  test("monorepo subpackage uses the TypeScript hoisted at the workspace root", async (t) => {
    const mono = join(root, "mono");
    install(mono, { typescript: TS7_SPEC });
    const project = copyFixture(join(mono, "packages", "my sub"));
    const r = await runSession(project);
    t.diagnostic(r.launcherLog);
    assert.ok(r.launcherLog.includes(`at ${join(mono, "node_modules", "typescript")} `), r.launcherLog);
    assertWorks(r);
  });

  test("without project TypeScript, a global tsc 7 on PATH is used", async (t) => {
    const tool = join(root, "global tsc");
    install(tool, { typescript: TS7_SPEC });
    const project = copyFixture(join(root, "no-ts"));
    const r = await runSession(project, {
      ...process.env,
      PATH: `${nodeOnlyBin}:${join(tool, "node_modules", ".bin")}`,
    });
    t.diagnostic(r.launcherLog);
    assert.match(r.launcherLog, /global tsc 7\.\S+ -> tsc --lsp --stdio \(diagnostics bridged\)/);
    assertWorks(r);
  });

  test("without any TypeScript, the launcher fails with an install hint", () => {
    const project = copyFixture(join(root, "nothing"));
    const r = spawnSync(process.execPath, [launcher], {
      env: { ...process.env, PATH: nodeOnlyBin, CLAUDE_PROJECT_DIR: project },
      input: "",
      encoding: "utf8",
    });
    assert.equal(r.status, 127);
    assert.match(r.stderr, /no TypeScript found/);
    assert.match(r.stderr, /pnpm add -D typescript-language-server/);
  });
});
