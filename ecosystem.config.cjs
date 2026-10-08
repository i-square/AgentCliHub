// PM2 进程配置（CommonJS；项目为 "type": "module"，故用 .cjs 后缀）
// 用法: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "codexhub-web",
      script: "server/index.mjs",
      // 相对 PM2 启动时的 cwd 解析；请始终在项目根目录执行 pm2 命令
      cwd: __dirname,
      env: {
        HOST: "0.0.0.0",
        PORT: "8123",
        NODE_ENV: "production"
      },
      // 有本地状态（data/），保持单实例 fork 模式
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "300M",
      // 日志带时间戳，落盘到 data/logs/
      time: true,
      out_file: "data/logs/out.log",
      error_file: "data/logs/error.log"
    }
  ]
};
