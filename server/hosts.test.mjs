import test from "node:test";
import assert from "node:assert/strict";
import { applyLocalDuplicateRules } from "./hosts.mjs";

const hosts = [
  { id: "local", kind: "local", hostName: "", enabled: true, blocked: false, duplicateOfLocal: false },
  { id: "PC-Win", kind: "ssh", hostName: "10.22.36.166", enabled: true, blocked: false, duplicateOfLocal: false },
  { id: "PC-WSL", kind: "ssh", hostName: "10.22.36.166", enabled: true, blocked: false, duplicateOfLocal: false },
  { id: "other", kind: "ssh", hostName: "10.22.160.52", enabled: true, blocked: false, duplicateOfLocal: false },
  { id: "blocked", kind: "ssh", hostName: "10.22.36.166", enabled: false, blocked: true, duplicateOfLocal: false }
];

test("同 IP + 同 shell 仅禁用 SSH 重复项，local 保持可用", () => {
  const result = applyLocalDuplicateRules(hosts, new Set(["10.22.36.166"]), {
    local: "windows", "PC-Win": "windows", "PC-WSL": "bash", other: "windows", blocked: "windows"
  });
  assert.strictEqual(result.find(h => h.id === "local").enabled, true);
  assert.strictEqual(result.find(h => h.id === "PC-Win").enabled, false);
  assert.strictEqual(result.find(h => h.id === "PC-Win").duplicateOfLocal, true);
  assert.strictEqual(result.find(h => h.id === "PC-Win").blocked, false, "同机禁用不等于用户屏蔽");
  assert.strictEqual(result.find(h => h.id === "PC-WSL").enabled, true, "相同 IP 但 Bash 与 Windows 是不同环境");
  assert.strictEqual(result.find(h => h.id === "other").enabled, true);
  assert.strictEqual(result.find(h => h.id === "blocked").blocked, true, "用户屏蔽状态独立保留");
});

test("shell 检测失败的候选不会被误禁用", () => {
  const result = applyLocalDuplicateRules(hosts, new Set(["10.22.36.166"]), { local: "windows" });
  assert.strictEqual(result.find(h => h.id === "PC-Win").enabled, true);
});
