# Windows 部署（PM2 + 开机自启）

适用于 Windows 10/11 + PowerShell 7（pwsh）。通过 PM2 守护进程（崩溃自动重启），配合 `pm2-windows-startup` 实现登录后自动恢复。

> ⚠️ **安全警告**：本工具能以当前用户身份在各主机执行命令。`HOST=0.0.0.0` 会把服务暴露到整个局域网，仅在受信网络中使用，切勿暴露公网。

## 一次性安装

```powershell
npm install -g pm2 pm2-windows-startup
```

## 启动并保存进程列表

在项目根目录执行：

```powershell
npm run build                        # 确保 dist/ 为最新前端产物
pm2 start ecosystem.config.cjs       # 启动（HOST=0.0.0.0, PORT=8123 已在配置中注入）
pm2 save                             # 保存进程列表到 ~/.pm2/dump.pm2
```

访问 http://localhost:8123 验证。

## 配置开机自启

```powershell
pm2-startup install
```

该命令向注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 写入开机项，用户登录后自动执行 `pm2 resurrect` 恢复已保存的进程列表。

**局限性**：依赖用户登录，注销后进程停止。如需"无登录也运行"的系统级服务，可改用 [pm2-installer](https://github.com/jon-hall/pm2-installer)（注册为 Windows Service）或 NSSM，本文不展开。

## 常用运维命令

```powershell
pm2 list                  # 查看进程状态
pm2 logs codexhub-web     # 实时日志（落盘文件在 data/logs/）
pm2 restart codexhub-web  # 重启（代码更新后：npm run build; pm2 restart codexhub-web）
pm2 stop codexhub-web     # 停止
pm2 monit                 # CPU/内存监控
```

## 卸载

```powershell
pm2-startup uninstall     # 移除开机项
pm2 delete codexhub-web   # 移除进程
pm2 save                  # 同步清空 dump
npm uninstall -g pm2 pm2-windows-startup
```

## 防火墙

首次绑定 `0.0.0.0` 时 Windows 可能弹出防火墙提示，勾选"专用网络"即可。若需手动放行：

```powershell
New-NetFirewallRule -DisplayName "CodexHub Web 8123" -Direction Inbound -Protocol TCP -LocalPort 8123 -Action Allow -Profile Private
```
