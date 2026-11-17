import test from "node:test";
import assert from "node:assert/strict";
import { normalizeShellOverride, parseWindowsShellProbe } from "./hostShell.mjs";

test("shell 手动覆盖只接受明确支持的值", () => {
  assert.deepEqual(normalizeShellOverride("pwsh"), { family: "windows", executable: "pwsh", source: "override" });
  assert.deepEqual(normalizeShellOverride("PowerShell"), { family: "windows", executable: "powershell", source: "override" });
  assert.deepEqual(normalizeShellOverride("bash"), { family: "bash", executable: "bash", source: "override" });
  assert.strictEqual(normalizeShellOverride(""), null);
  assert.throws(() => normalizeShellOverride("zsh"), /仅支持 pwsh、powershell、bash/);
});

test("PowerShell 探测只从完整标记识别，并区分 Core/Desktop", () => {
  assert.deepEqual(parseWindowsShellProbe("banner\r\n__ACH_WINDOWS_POWERSHELL__\r\nCore\r\n"), {
    family: "windows", executable: "pwsh", source: "detected"
  });
  assert.deepEqual(parseWindowsShellProbe("__ACH_WINDOWS_POWERSHELL__\nDesktop\n"), {
    family: "windows", executable: "powershell", source: "detected"
  });
  assert.strictEqual(parseWindowsShellProbe("Write-Output: command not found"), null);
  assert.strictEqual(parseWindowsShellProbe("__ACH_WINDOWS_POWERSHELL__"), null, "缺少版本标记时不猜测默认解释器");
});
