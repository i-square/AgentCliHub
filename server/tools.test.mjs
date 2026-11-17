// 合并逻辑回归测试：确保合并时不丢失 settings 中的其他字段，且 catalog 内外条目按预期处理
import assert from "node:assert";
import { mergeModelPicker, parseSettingsText } from "./tools.mjs";

// ── mergeModelPicker ─────────────────────────────────────────────────────────
const catalogSlugs = new Set(["glm-5.3", "k3", "kimi-for-coding", "deepseek-v4-pro"]);

console.log("测试 1：空 settings 写入新 options");
{
  const r = mergeModelPicker({}, [{ model: "k3[1m]", label: "Kimi K3" }], catalogSlugs);
  assert.deepStrictEqual(r.settings.modelPicker.options, [{ model: "k3[1m]", label: "Kimi K3" }]);
  assert.strictEqual(r.kept, 0, "无手工条目");
  assert.ok(!("env" in r.settings), "不引入其他字段");
}

console.log("测试 2：保留 settings 其他字段");
{
  const cur = { env: { A: "1" }, outputStyle: "pro", modelPicker: { options: [] } };
  const r = mergeModelPicker(cur, [{ model: "k3[1m]", label: "K3" }], catalogSlugs);
  assert.strictEqual(r.settings.env.A, "1");
  assert.strictEqual(r.settings.outputStyle, "pro");
  assert.strictEqual(r.kept, 0);
}

console.log("测试 3：手工条目（catalog 外）保留且排在后面");
{
  const cur = {
    modelPicker: {
      options: [
        { model: "glm-5.3[1m]", label: "旧 GLM" },
        { model: "my-custom", label: "手工" },
        { model: "k3[1m]", label: "旧 K3" }
      ]
    }
  };
  const newOpts = [{ model: "deepseek-v4-pro[1m]", label: "DeepSeek" }];
  const r = mergeModelPicker(cur, newOpts, catalogSlugs);
  assert.deepStrictEqual(
    r.settings.modelPicker.options.map((o) => o.model),
    ["deepseek-v4-pro[1m]", "my-custom"]
  );
  assert.strictEqual(r.kept, 1, "my-custom 是手工条目");
}

console.log("测试 4：多个手工条目按原顺序保留");
{
  const cur = {
    modelPicker: {
      options: [
        { model: "glm-5.3[1m]", label: "旧" },
        { model: "extra-1", label: "手工1" },
        { model: "k3[1m]", label: "旧2" },
        { model: "extra-2", label: "手工2" }
      ]
    }
  };
  const r = mergeModelPicker(cur, [{ model: "kimi-for-coding[1m]", label: "Kimi" }], catalogSlugs);
  assert.deepStrictEqual(
    r.settings.modelPicker.options.map((o) => o.model),
    ["kimi-for-coding[1m]", "extra-1", "extra-2"]
  );
  assert.strictEqual(r.kept, 2);
}

console.log("测试 5：去掉 [1m] 后缀再匹配 catalog slug");
{
  const cur = { modelPicker: { options: [{ model: "k3[1m]", label: "旧" }, { model: "orphan", label: "孤儿" }] } };
  const r = mergeModelPicker(cur, [{ model: "k3", label: "新K3不带后缀" }], catalogSlugs);
  assert.deepStrictEqual(
    r.settings.modelPicker.options.map((o) => o.model),
    ["k3", "orphan"]
  );
  assert.strictEqual(r.kept, 1);
}

// ── parseSettingsText ────────────────────────────────────────────────────────
console.log("测试 6：空文本 → {}");
assert.deepStrictEqual(parseSettingsText("", "test"), {});
assert.deepStrictEqual(parseSettingsText("  \n ", "test"), {});

console.log("测试 7：非法 JSON 抛错");
assert.throws(() => parseSettingsText("{broken", "test.json"), /不是合法的 JSON 对象/);
assert.throws(() => parseSettingsText("[]", "test.json"), /不是合法的 JSON 对象/);
assert.throws(() => parseSettingsText("null", "test.json"), /不是合法的 JSON 对象/);

console.log("测试 8：合法 JSON 对象通过");
assert.deepStrictEqual(parseSettingsText('{"a":1}', "test"), { a: 1 });

// 文件读写的错误、权限与协议回归现由 hostFiles.test.mjs 覆盖。
