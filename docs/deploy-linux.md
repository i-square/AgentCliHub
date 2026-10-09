# Linux 部署

> ⚠️ **安全警告**：本工具能以部署用户身份在各主机执行命令。`HOST=0.0.0.0` 会暴露到整个网络，仅在受信内网使用，切勿暴露公网。

通用前置步骤：

```bash
npm ci
npm run build   # 生成 dist/ 前端产物
```

以下三种方式按推荐程度排序：systemd > PM2 > nohup。

## 方式一：systemd（推荐）

系统级服务，开机自启、崩溃自动重启、日志进 journald，无需额外依赖。

创建 `/etc/systemd/system/AgentCliHub-web.service`：

```ini
[Unit]
Description=AgentCliHub
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/opt/AgentCliHub
Environment=HOST=0.0.0.0
Environment=PORT=8123
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server/index.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now AgentCliHub-web
systemctl status AgentCliHub-web        # 查看状态
journalctl -u AgentCliHub-web -f        # 跟踪日志
```

注意：`ExecStart` 中的 node 路径按实际调整（`which node`）；nvm 安装时路径形如 `/home/USER/.nvm/versions/node/vXX/bin/node`。

## 方式二：PM2

与 Windows 一致的进程管理体验：

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs   # HOST/PORT 已在配置中注入
pm2 save                         # 保存进程列表
pm2 startup                      # 生成自启脚本，按提示复制执行输出的 sudo env ... 命令
```

常用命令同 Windows 文档（`pm2 list` / `pm2 logs` / `pm2 restart AgentCliHub-web`）。

## 方式三：nohup（临时/极简场景）

无自启、无崩溃重启，仅适合临时运行：

```bash
HOST=0.0.0.0 PORT=8123 nohup node server/index.mjs > data/logs/app.log 2>&1 &
echo $! > data/app.pid             # 记录 PID

# 停止
kill $(cat data/app.pid)
```

## 方式四：Docker（TODO，暂未实现）

预留。计划要点：

- 多阶段构建：`node:XX-alpine` 构建前端，运行时仅拷贝 `dist/` + `server/` + 生产依赖
- 挂载 `data/` 卷持久化配置与状态
- 需挂载宿主 `~/.ssh`（只读）才能管理 SSH 主机，安全模型需重新评估
- 容器内建议用 `pm2-runtime` 或直接 `node` 前台运行（PID 1）
