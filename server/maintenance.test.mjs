import test from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "./exec.mjs";
import { bashQuote } from "./hostFiles.mjs";
import { buildManagedPathBlock, editManagedPathRc } from "./maintenance.mjs";

test("PATH 配置编辑保留其他内容、替换完整块并拒绝损坏边界", () => {
  const original = '# 用户配置\nexport CUSTOM="keep"\n';
  const first = editManagedPathRc(original, "~/.local/bin");
  assert.ok(first.startsWith(original));
  assert.equal(editManagedPathRc(first, "~/.local/bin"), first);
  const second = editManagedPathRc(first + "echo tail\n", "~/new bin");
  assert.ok(second.endsWith("echo tail\n"));
  assert.equal(second.split("# >>> AgentCliHub managed PATH").length, 2);
  assert.throws(() => editManagedPathRc("# >>> AgentCliHub managed PATH\nexport SECRET=x", "/bin"), /缺少结束标记/);
  assert.throws(() => editManagedPathRc("# <<< AgentCliHub managed PATH\n", "/bin"), /缺少起始标记/);
});

for (const executable of ["bash", "zsh"]) {
  test(`${executable}：PATH 置顶块保留空格、去除重复入口且幂等`, { skip: process.platform === "win32" }, async (t) => {
    const available = await runProcess(executable, ["--version"]);
    if (available.code !== 0) return t.skip(`${executable} 不可用`);
    const dir = "/tmp/tool bin ' $literal";
    const original = `/usr/bin:${dir}:/some path:${dir}:/bin`;
    const block = buildManagedPathBlock(dir);
    const script = `PATH=${bashQuote(original)}\n${block}\n${block}\nprintf '%s' "$PATH"`;
    const result = await runProcess(executable, ["-c", script]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `${dir}:/usr/bin:/some path:/bin`);
  });
}
