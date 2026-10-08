// 开发模式：同时启动后端 API (8722) 与 Vite 前端 (5173，代理 /api)
import { spawn } from "node:child_process";

const procs = [
  spawn(process.execPath, ["server/index.mjs"], { stdio: "inherit" }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], { stdio: "inherit" })
];

function shutdown() {
  for (const p of procs) p.kill("SIGTERM");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
