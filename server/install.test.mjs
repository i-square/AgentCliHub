import assert from "node:assert";
import { parseRemoteReadResult } from "./install.mjs";

const begin = "__ACH_BEGIN_7f3d__";
const end = "__ACH_END_7f3d__";
const diagnostic = "client_global_hostkeys_prove_confirm: server gave bad signature for RSA key 0: incorrect signature";
const config = 'model = "k3"\nmodel_reasoning_effort = "high"\n';
const stdout = `${begin}\n${config}\n${end}\n`;
// 模拟旧执行层将 ssh stderr 插入 begin/end 之间；新解析必须只采用独立 stdout。
const combined = `${begin}\n${config}${diagnostic}\n${end}\n`;

console.log("测试 1：ssh stderr 诊断不会进入 config.toml 内容");
{
  const r = parseRemoteReadResult({ code: 0, stdout, stderr: `${diagnostic}\n`, output: combined });
  assert.strictEqual(r.state, "ok");
  assert.ok(r.content.includes('model = "k3"'));
  assert.ok(!r.content.includes("client_global_hostkeys_prove_confirm"));
  assert.ok(!r.content.includes("incorrect signature"));
}

console.log("测试 2：没有分离流字段的旧调用方仍按 output 解析");
{
  const r = parseRemoteReadResult({ code: 0, output: stdout });
  assert.strictEqual(r.state, "ok");
  assert.ok(r.content.includes('model_reasoning_effort = "high"'));
}

console.log("✅ install 远程读取回归测试通过");
