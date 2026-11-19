import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateCdpGuard } from "./scripts/cdp-guard.mjs";

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pluginDir, "..", "..");

test("Antigravity plugin manifest, assets, rules, hooks, and bundled skill are valid and in sync", () => {
  const manifestPath = path.join(pluginDir, "plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const rootPkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );

  assert.equal(manifest.name, "cdp-bridge");
  assert.ok(manifest.displayName);
  assert.equal(manifest.version, rootPkg.version);
  assert.ok(manifest.description.length > 10);
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.logo, "assets/logo.svg");

  const logoPath = path.join(pluginDir, manifest.logo);
  assert.ok(fs.existsSync(logoPath), "assets/logo.svg must exist");
  assert.match(fs.readFileSync(logoPath, "utf8"), /<svg\b/);

  const hooksPath = path.join(pluginDir, "hooks.json");
  const hooks = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  assert.ok(hooks["cdp-direct-port-guard"]?.PreToolUse?.length === 1);

  const rulePath = path.join(pluginDir, "rules", "AGENTS.md");
  const ruleText = fs.readFileSync(rulePath, "utf8");
  assert.ok(
    !ruleText.startsWith("---"),
    "Standalone rules/AGENTS.md must not contain YAML frontmatter",
  );
  assert.ok(
    Buffer.byteLength(ruleText, "utf8") < 4096,
    "rules/AGENTS.md should stay concise",
  );

  const canonicalSkill = fs.readFileSync(
    path.join(repoRoot, "skills", "cdp-bridge", "SKILL.md"),
    "utf8",
  );
  const bundledSkill = fs.readFileSync(
    path.join(pluginDir, "skills", "cdp-bridge", "SKILL.md"),
    "utf8",
  );
  assert.equal(
    bundledSkill,
    canonicalSkill,
    "Bundled plugin SKILL.md must stay identical to skills/cdp-bridge/SKILL.md",
  );
});

test("cdp-guard PreToolUse blocks direct CDP port bypasses without false positives", () => {
  // Blocked direct bypasses
  assert.equal(
    evaluateCdpGuard("run_command", {
      CommandLine: "curl -s http://127.0.0.1:9222/json/version",
    }).decision,
    "deny",
  );
  assert.equal(
    evaluateCdpGuard("run_command", {
      CommandLine: "cd /tmp && NO_PROXY=* curl http://localhost:9222/json/list",
    }).decision,
    "deny",
  );
  assert.equal(
    evaluateCdpGuard("run_command", {
      CommandLine: "wscat -c ws://127.0.0.1:9222/devtools/browser/abc-123",
    }).decision,
    "deny",
  );
  assert.equal(
    evaluateCdpGuard("run_command", {
      CommandLine:
        'python3 -c "from playwright.sync_api import sync_playwright; p=sync_playwright().start(); p.chromium.connect_over_cdp(\'http://127.0.0.1:9222\')"',
    }).decision,
    "deny",
  );

  // Allowed legitimate commands
  assert.equal(
    evaluateCdpGuard("run_command", {
      CommandLine: "cdp connect 127.0.0.1:9222 && cdp pages",
    }).decision,
    "allow",
  );
  assert.equal(
    evaluateCdpGuard("run_command", {
      CommandLine: 'git commit -m "docs: forbid curl http://127.0.0.1:9222/json"',
    }).decision,
    "allow",
  );
  assert.equal(
    evaluateCdpGuard("run_command", {
      CommandLine: 'rg "connect_over_cdp.*9222" .',
    }).decision,
    "allow",
  );
  assert.equal(
    evaluateCdpGuard("run_command", {
      CommandLine: "CDP_ALLOW_DIRECT=1 curl http://127.0.0.1:9222/json/version",
    }).decision,
    "allow",
  );
  assert.equal(
    evaluateCdpGuard("read_file", {
      Path: "/tmp/curl-9222.txt",
    }).decision,
    "allow",
  );
});

test("cdp-guard CLI entrypoint follows Antigravity stdin/stdout JSON contract", () => {
  const guardScript = path.join(pluginDir, "scripts", "cdp-guard.mjs");

  const blocked = spawnSync(process.execPath, [guardScript], {
    cwd: pluginDir,
    encoding: "utf8",
    input: JSON.stringify({
      hookEventName: "PreToolUse",
      toolCall: {
        id: "toolu_test_1",
        name: "run_command",
        args: { CommandLine: "curl http://127.0.0.1:9222/json" },
      },
    }),
  });
  assert.equal(blocked.status, 0);
  const blockedOut = JSON.parse(blocked.stdout.trim());
  assert.equal(blockedOut.decision, "deny");
  assert.match(blockedOut.reason, /cdp pages/);

  const allowed = spawnSync(process.execPath, [guardScript], {
    cwd: pluginDir,
    encoding: "utf8",
    input: JSON.stringify({
      hookEventName: "PreToolUse",
      toolCall: {
        id: "toolu_test_2",
        name: "run_command",
        args: { CommandLine: "cdp elements 426B5451" },
      },
    }),
  });
  assert.equal(allowed.status, 0);
  const allowedOut = JSON.parse(allowed.stdout.trim());
  assert.equal(allowedOut.decision, "allow");
});
