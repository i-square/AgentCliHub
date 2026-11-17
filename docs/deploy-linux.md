# Linux 部署

> ⚠️ **安全警告**：本工具能以部署用户身份在本机及 SSH 主机执行命令，且不提供身份认证。`HOST=0.0.0.0` 会暴露到整个网络，仅允许受信内网访问，切勿暴露公网。

Linux 本机与 SSH Windows/Linux 主机共用相同的运行时与能力判断。独立安装、npm 更新、配置写入、重启和维护操作按目标平台选择实现，不再要求把 Linux 本机额外配置成 SSH 主机。

## 前置准备

推荐使用 Node.js 22.19.0，先完成依赖安装与前端构建：

```bash
npm ci
npm run build
```

以下方式按推荐程度排序：**systemd 用户服务 > systemd 系统服务 > PM2 > nohup**。

不要依赖 Codex、IDE 自动化任务或其他代理工具的会话维持生产进程。此类会话可能是 app-server 的子进程，宿主更新或退出时，Hub 也会随之停止。

## 方式一：systemd 用户服务（单机推荐）

无需 sudo，服务由用户 systemd 管理，不再依附终端或 Codex app-server，并支持失败自动重启。

创建 `~/.config/systemd/user/AgentCliHub-web.service`：

```ini
[Unit]
Description=AgentCliHub Web Console
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/USER/repos/AgentCliHub
Environment=HOST=0.0.0.0
Environment=PORT=8123
Environment=NODE_ENV=production
ExecStart=/home/USER/.nvm/versions/node/v22.19.0/bin/node server/index.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

将 `USER`、仓库路径和 Node 路径替换为实际值。加载 NVM 后可执行 `which node` 确认路径；升级 NVM Node 版本后，也要同步调整 `ExecStart`。

启用并启动：

```bash
systemctl --user daemon-reload
systemctl --user enable --now AgentCliHub-web.service
systemctl --user status AgentCliHub-web.service
```

常用运维：

```bash
systemctl --user restart AgentCliHub-web.service
journalctl --user -u AgentCliHub-web.service -f
systemctl --user disable --now AgentCliHub-web.service  # 停止并取消自启
```

需要用户未登录时也保持运行，应启用 Linger：

```bash
loginctl show-user "$USER" -p Linger
sudo loginctl enable-linger "$USER"  # 已为 Linger=yes 时无需执行
```

代码更新后：

```bash
npm ci
npm run build
systemctl --user restart AgentCliHub-web.service
```

## 方式二：systemd 系统服务

适合由管理员统一部署、明确指定运行账号的机器。

创建 `/etc/systemd/system/AgentCliHub-web.service`：

```ini
[Unit]
Description=AgentCliHub Web Console
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

启用与运维：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now AgentCliHub-web.service
systemctl status AgentCliHub-web.service
journalctl -u AgentCliHub-web.service -f
```

`ExecStart` 中的 Node 路径按实际调整，仓库目录必须允许 `YOUR_USER` 读取，并确保 `data/` 可写。

## 方式三：PM2

与 Windows 一致的进程管理体验：

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # 按输出提示完成自启配置
```

常用命令：

```bash
pm2 list
pm2 logs AgentCliHub-web
pm2 restart AgentCliHub-web
```

## 方式四：nohup（仅临时使用）

无开机自启和崩溃重启，且仍可能受调用进程的进程组或 Job 约束，不适合作为正式常驻方案：

```bash
mkdir -p data/logs
HOST=0.0.0.0 PORT=8123 nohup node server/index.mjs > data/logs/app.log 2>&1 &
echo $! > data/app.pid

# 停止
kill "$(cat data/app.pid)"
```

## Docker

尚未提供正式 Docker 部署配置。
