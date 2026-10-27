import test from "node:test";
import assert from "node:assert/strict";
import { applyPriorityBand } from "./catalogs.mjs";

test("源中有 priority 时加分段起点并保留间隔", () => {
  const source = {
    models: [
      { slug: "glm-5.3", priority: 0 },
      { slug: "glm-5-turbo", priority: 2 }
    ]
  };
  const result = applyPriorityBand(source, 100);
  assert.deepEqual(result.models.map((m) => m.priority), [100, 102]);
  assert.deepEqual(source.models.map((m) => m.priority), [0, 2], "不应修改源响应");
});

test("DeepSeek 的非零起点原样保留", () => {
  const result = applyPriorityBand({
    models: [
      { slug: "deepseek-flash", priority: 1 },
      { slug: "deepseek-v4-pro", priority: 2 }
    ]
  }, 300);
  assert.deepEqual(result.models.map((m) => m.priority), [301, 302]);
});

test("源中没有 priority 时按返回顺序从分段起点编号", () => {
  const result = applyPriorityBand({
    models: [
      { slug: "kimi-for-coding" },
      { slug: "kimi-for-coding-highspeed" },
      { slug: "k3" }
    ]
  }, 200);
  assert.deepEqual(result.models.map(({ slug, priority }) => ({ slug, priority })), [
    { slug: "kimi-for-coding", priority: 200 },
    { slug: "kimi-for-coding-highspeed", priority: 201 },
    { slug: "k3", priority: 202 }
  ]);
});
