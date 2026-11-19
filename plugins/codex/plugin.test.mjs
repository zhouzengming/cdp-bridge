import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateCodexPreToolUse } from "./scripts/cdp-guard.mjs";

const codexPluginDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(codexPluginDir, "..", "..");
const codexMcpPluginDir = path.join(repoRoot, "plugins", "codex-mcp");
const catalogPath = path.join(repoRoot, ".agents", "plugins", "marketplace.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("repo-root Codex marketplace catalog (.agents/plugins/marketplace.json) is valid and matches both Codex plugins", () => {
  assert.ok(fs.existsSync(catalogPath), "missing .agents/plugins/marketplace.json");
  const catalog = readJson(catalogPath);
  const rootPkg = readJson(path.join(repoRoot, "package.json"));

  assert.equal(catalog.name, "cdp-bridge");
  assert.ok(Array.isArray(catalog.plugins) && catalog.plugins.length === 2);

  const expected = [
    { name: "cdp-bridge", dir: codexPluginDir, relPath: "./plugins/codex", hasMcp: false },
    { name: "cdp-bridge-mcp", dir: codexMcpPluginDir, relPath: "./plugins/codex-mcp", hasMcp: true },
  ];

  const canonicalSkill = fs.readFileSync(
    path.join(repoRoot, "skills", "cdp-bridge", "SKILL.md"),
    "utf8",
  );

  for (const item of expected) {
    const entry = catalog.plugins.find((p) => p.name === item.name);
    assert.ok(entry, `catalog must list "${item.name}"`);
    assert.equal(entry.source?.source, "local");
    assert.equal(entry.source?.path, item.relPath);
    assert.equal(path.resolve(repoRoot, entry.source.path), item.dir);
    assert.ok(
      ["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"].includes(
        entry.policy?.installation,
      ),
    );
    assert.ok(
      ["ON_INSTALL", "ON_USE"].includes(entry.policy?.authentication),
    );

    const manifest = readJson(path.join(item.dir, ".codex-plugin", "plugin.json"));
    assert.equal(manifest.name, item.name);
    assert.equal(manifest.version, rootPkg.version);
    assert.equal(manifest.hooks, "./hooks/hooks.json");
    assert.equal(manifest.skills, "./skills/");

    const hooks = readJson(path.join(item.dir, "hooks", "hooks.json"));
    const preGroups = hooks.hooks?.PreToolUse || [];
    assert.deepEqual(preGroups.map((g) => g.matcher), ["Bash"]);
    assert.equal(
      preGroups[0].hooks[0].command,
      'node "${PLUGIN_ROOT}/scripts/cdp-guard.mjs"',
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
      const srv = mcp.mcpServers?.["cdp-bridge"];
      assert.ok(srv, "codex-mcp .mcp.json must declare mcpServers['cdp-bridge']");
      assert.equal(srv.command, "cdp-mcp");
      const envSet = new Set(srv.env_vars || []);
      for (const reqVar of [
        "CDP_BRIDGE_SOCKET",
        "CDP_HOST",
        "CDP_PORT",
        "CDP_WS_URL",
        "CDP_CURSOR",
        "XDG_RUNTIME_DIR",
        "LOCALAPPDATA",
        "TEMP",
      ]) {
        assert.ok(envSet.has(reqVar), `.mcp.json env_vars must forward ${reqVar}`);
      }
    } else {
      assert.equal(manifest.mcpServers, undefined);
    }
  }
});

test("Codex PreToolUse cdp-guard enforces standard hookSpecificOutput deny contract without false positives", () => {
  const deniedCurl = evaluateCodexPreToolUse({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "curl -s http://127.0.0.1:9222/json/list" },
  });
  assert.equal(deniedCurl.hookSpecificOutput?.hookEventName, "PreToolUse");
  assert.equal(deniedCurl.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(deniedCurl.hookSpecificOutput?.permissionDecisionReason, /cdp pages/);

  const deniedPlaywright = evaluateCodexPreToolUse({
    tool_name: "Bash",
    tool_input: {
      command:
        'python3 -c "p.chromium.connect_over_cdp(\'http://127.0.0.1:9222\')"',
    },
  });
  assert.equal(deniedPlaywright.hookSpecificOutput?.permissionDecision, "deny");

  // Legitimate commands return empty object (no opinion -> Codex keeps normal flow)
  assert.deepEqual(
    evaluateCodexPreToolUse({
      tool_name: "Bash",
      tool_input: { command: "cdp connect 127.0.0.1:9222 && cdp pages" },
    }),
    {},
  );
  assert.deepEqual(
    evaluateCodexPreToolUse({
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "block curl http://127.0.0.1:9222/json"' },
    }),
    {},
  );
  assert.deepEqual(
    evaluateCodexPreToolUse({
      tool_name: "Bash",
      tool_input: { command: "CDP_ALLOW_DIRECT=1 curl http://127.0.0.1:9222/json/version" },
    }),
    {},
  );
});

test("Codex cdp-guard CLI prints nothing on allow and deny JSON on block", () => {
  const scriptPath = path.join(codexPluginDir, "scripts", "cdp-guard.mjs");

  const blocked = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "wscat -c ws://127.0.0.1:9222/devtools/browser/abc" },
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
      tool_input: { command: "cdp elements 426B5451" },
    }),
  });
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout.trim(), "");
});
