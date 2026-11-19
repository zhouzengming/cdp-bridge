import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateClaudePreToolUse } from "./scripts/cdp-guard.mjs";

const claudePluginDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(claudePluginDir, "..", "..");
const claudeMcpPluginDir = path.join(repoRoot, "plugins", "claude-code-mcp");
const catalogPath = path.join(repoRoot, ".claude-plugin", "marketplace.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("repo-root Claude Code marketplace (.claude-plugin/marketplace.json) is valid and matches both Claude Code plugins", () => {
  assert.ok(fs.existsSync(catalogPath), "missing .claude-plugin/marketplace.json");
  const catalog = readJson(catalogPath);
  const rootPkg = readJson(path.join(repoRoot, "package.json"));

  assert.equal(catalog.name, "cdp-bridge");
  assert.ok(catalog.owner?.name);
  assert.ok(Array.isArray(catalog.plugins) && catalog.plugins.length === 2);

  const canonicalSkill = fs.readFileSync(
    path.join(repoRoot, "skills", "cdp-bridge", "SKILL.md"),
    "utf8",
  );

  const expected = [
    { name: "cdp-bridge", dir: claudePluginDir, relPath: "./plugins/claude-code", hasMcp: false },
    { name: "cdp-bridge-mcp", dir: claudeMcpPluginDir, relPath: "./plugins/claude-code-mcp", hasMcp: true },
  ];

  for (const item of expected) {
    const entry = catalog.plugins.find((p) => p.name === item.name);
    assert.ok(entry, `marketplace must list "${item.name}"`);
    assert.equal(entry.source, item.relPath);
    assert.equal(entry.version, rootPkg.version);
    assert.equal(path.resolve(repoRoot, entry.source), item.dir);

    const manifest = readJson(path.join(item.dir, ".claude-plugin", "plugin.json"));
    assert.equal(manifest.name, item.name);
    assert.equal(manifest.version, rootPkg.version);

    const hooks = readJson(path.join(item.dir, "hooks", "hooks.json"));
    const preGroups = hooks.hooks?.PreToolUse || [];
    assert.deepEqual(preGroups.map((g) => g.matcher), ["Bash"]);
    assert.equal(
      preGroups[0].hooks[0].command,
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/cdp-guard.mjs"',
    );

    const bundledSkill = fs.readFileSync(
      path.join(item.dir, "skills", "cdp-bridge", "SKILL.md"),
      "utf8",
    );
    assert.equal(
      bundledSkill,
      canonicalSkill,
      `${item.name} bundled SKILL.md must stay byte-identical to skills/cdp-bridge/SKILL.md`,
    );

    if (item.hasMcp) {
      assert.equal(manifest.mcpServers, "./.mcp.json");
      const mcp = readJson(path.join(item.dir, ".mcp.json"));
      assert.equal(mcp["cdp-bridge"]?.command, "cdp-mcp");
    } else {
      assert.equal(manifest.mcpServers, undefined);
    }
  }
});

test("Claude Code PreToolUse cdp-guard enforces hookSpecificOutput deny contract without false positives", () => {
  const deniedCurl = evaluateClaudePreToolUse({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "curl -s http://127.0.0.1:9222/json/version" },
  });
  assert.equal(deniedCurl.hookSpecificOutput?.hookEventName, "PreToolUse");
  assert.equal(deniedCurl.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(deniedCurl.hookSpecificOutput?.permissionDecisionReason, /cdp pages/);

  const deniedPlaywright = evaluateClaudePreToolUse({
    tool_name: "Bash",
    tool_input: {
      command:
        'python3 -c "p.chromium.connect_over_cdp(\'http://127.0.0.1:9222\')"',
    },
  });
  assert.equal(deniedPlaywright.hookSpecificOutput?.permissionDecision, "deny");

  assert.deepEqual(
    evaluateClaudePreToolUse({
      tool_name: "Bash",
      tool_input: { command: "cdp connect 127.0.0.1:9222 && cdp pages" },
    }),
    {},
  );
  assert.deepEqual(
    evaluateClaudePreToolUse({
      tool_name: "Bash",
      tool_input: { command: "CDP_ALLOW_DIRECT=1 curl http://127.0.0.1:9222/json/version" },
    }),
    {},
  );
});

test("Claude Code cdp-guard CLI prints nothing on allow and deny JSON on block", () => {
  const scriptPath = path.join(claudePluginDir, "scripts", "cdp-guard.mjs");

  const blocked = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "websocat ws://127.0.0.1:9222/devtools/browser/abc" },
    }),
  });
  assert.equal(blocked.status, 0);
  const parsed = JSON.parse(blocked.stdout.trim());
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");

  const allowed = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "cdp pages" },
    }),
  });
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout.trim(), "");
});
