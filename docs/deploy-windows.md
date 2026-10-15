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
pm2 logs AgentCliHub-web     # 实时日志（落盘文件在 data/logs/）
pm2 restart AgentCliHub-web  # 重启（代码更新后：npm run build; pm2 restart AgentCliHub-web）
pm2 stop AgentCliHub-web     # 停止
pm2 monit                 # CPU/内存监控
```

## 卸载

```powershell
pm2-startup uninstall     # 移除开机项
pm2 delete AgentCliHub-web   # 移除进程
pm2 save                  # 同步清空 dump
npm uninstall -g pm2 pm2-windows-startup
```

## 防火墙

首次绑定 `0.0.0.0` 时 Windows 可能弹出防火墙提示，勾选"专用网络"即可。若需手动放行：

```powershell
New-NetFirewallRule -DisplayName "AgentCliHub 8123" -Direction Inbound -Protocol TCP -LocalPort 8123 -Action Allow -Profile Private
```

## 后台启动的坑：Job Object（重要）

Windows 的 Job Object 在宿主进程退出时会**连带终止组内所有进程**。从带 Job 的宿主里直接启动 PM2（Codex/自动化代理会话、部分 IDE 集成终端、CI runner 等），daemon 与业务进程会随宿主退出被系统一并清理：表现为"退出宿主后 8123 打不开"（本机曾两次踩中，根因即会话内 `pm2 start / resurrect` 从零拉起 daemon）。普通用户终端启动、以及登录自启（pm2-windows-startup 由 explorer 拉起）不受影响。

从这类宿主里从零拉起 PM2 的正确方式：先把模板 `scripts/start-pm2-detached.cmd.template` 复制为同目录下的 `scripts/start-pm2-detached.cmd`（本机版已被 gitignore，可按本机情况调整路径），再经 WMI 启动（进程由系统服务创建，脱离调用者进程树与 Job）：

```powershell
$si = ([wmiclass]"Win32_ProcessStartup").CreateInstance(); $si.ShowWindow = 0
([wmiclass]"Win32_Process").Create('cmd.exe /c <仓库根>\scripts\start-pm2-detached.cmd', $null, $si)
```

脚本内容为 `pm2 resurrect`（PM2_HOME 在脚本内设置）。注意：**直接双击或普通终端运行该脚本不会脱离**，必须经 WMI（或计划任务/Windows 服务等系统级渠道）调用。

已验证结论（2026-10-15 实测）：

- daemon 独立运行后，日常 `pm2 restart AgentCliHub-web`（包括在自动化会话里执行）是安全的：重启由常驻 daemon 执行，不受会话退出影响。
- 业务进程与 daemon 相互独立：实测 `taskkill` 掉 daemon 后 8123 仍正常响应（HTTP 200），只需重新 `resurrect` 恢复 pm2 管理。
- 已知无害怪象：daemon 进程本身可能带某个 Job 标记（`IsProcessInJob` 返回 True，来源未明）；业务进程不受影响，不必处理。
- 快速自检：`taskkill /f /pid <daemon pid>` 后访问 8123，仍返回 200 即"服务已与宿主解耦"。
