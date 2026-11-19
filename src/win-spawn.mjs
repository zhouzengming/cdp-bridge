import { spawnSync } from "node:child_process";

/**
 * Quote a single argument according to Windows CommandLineToArgvW / CreateProcessW rules.
 */
export function quoteWindowsArg(value) {
  const str = String(value ?? "");
  if (str.length === 0) {
    return '""';
  }
  if (!/[\s"\t]/.test(str)) {
    return str;
  }
  let escaped = str.replace(/(\\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

export function formatWindowsCommandLine(execPath, args = []) {
  return [execPath, ...args].map(quoteWindowsArg).join(" ");
}

export function psSingleQuote(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

export function encodePowerShellCommand(script) {
  return Buffer.from(String(script), "utf16le").toString("base64");
}

export function buildWmiBreakawayPowerShellScript(execPath, args, cwd) {
  const commandLine = formatWindowsCommandLine(execPath, args);
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
    `$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psSingleQuote(commandLine)}; CurrentDirectory = ${psSingleQuote(cwd)}; ProcessStartupInformation = $si }`,
    "if ($res.ReturnValue -ne 0 -or -not $res.ProcessId) { exit 1 }",
    "Write-Output $res.ProcessId",
  ];
  return lines.join("; ");
}

/**
 * Spawn a background daemon on Windows outside the caller's Job Object
 * (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) via WMI `Win32_Process.Create`.
 * Prevents AI agent tool runners from killing `cdp-bridge` when a single
 * shell command step exits.
 */
export function trySpawnWindowsWmiBreakaway(execPath, args, cwd, env = process.env) {
  if (process.platform !== "win32") {
    return { ok: false, reason: "not-win32" };
  }
  if (String(env?.CDP_NO_WMI_BREAKAWAY || "").trim() === "1") {
    return { ok: false, reason: "disabled-by-env" };
  }

  try {
    const psScript = buildWmiBreakawayPowerShellScript(execPath, args, cwd);
    const encoded = encodePowerShellCommand(psScript);
    const res = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        encoded,
      ],
      {
        cwd,
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 8_000,
      },
    );

    if (res.status === 0) {
      const pid = Number(String(res.stdout || "").trim());
      if (Number.isInteger(pid) && pid > 0) {
        return { ok: true, pid };
      }
    }
    return {
      ok: false,
      reason: (res.stderr || res.error?.message || `exit-${res.status}`).trim(),
    };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}
