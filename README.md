# AgentCliHub

> 从 Tauri 桌面控制台重构而来的纯 Web 工具：统一管理多台机器上的 **Codex CLI** 与 **Claude Code**，默认使用官方独立二进制安装与更新，并保留 **npm** 兜底。

## 核心功能

### 主机与执行环境

- 自动发现本机与 `~/.ssh/config` 中的 SSH 主机，支持排除模式、Shell prelude 和主机级配置覆盖。
- 分别解析连接方式（local/SSH）、目标平台与执行器（PowerShell/Bash），避免把 Windows OpenSSH 错误切入 WSL。
- 用户屏蔽、同机自动禁用和技术能力互不混用；被屏蔽或同机禁用的主机不会进入批量操作。
- 只读状态检查与深度探测：版本、PATH 解析、安装候选、官方包根和自动更新配置。

### 安装、更新与维护

- **独立二进制默认**：支持 Windows/Linux 本机及 SSH 主机，官方目录布局、SHA-256 校验、安装后版本验证。
- **下载与中转**：目标机可直连时直接下载，否则由 hub 下载校验后经 SSH 流式中转。
- **渠道与版本**：支持 stable/latest/预发布或固定版本；版本缓存默认每 6 小时检查，可配置代理、镜像与 GitHub Token。
- **npm 兜底**：按主机或工具切换为 npm 安装与更新，支持 npm rename 失败后的受限清理重试。
- **维护操作**：PATH 预检与显式修复、旧版本清理、官方自动更新接管、Codex app-server 重启。
- **批量任务**：批量检查、探测、安装与更新；同主机写操作串行，任务日志通过 SSE 实时显示。

### 模型目录

- 集中维护 `data/catalogs/models.*.json`，支持官方 OAI 与自定义厂商 catalog。
- 提供 JSON 编辑、校验、优先级分段、重排、合并预览和变更对比。
- 推送前检查目标机 `model_catalog_json` 配置；推送采用原子写入并清理 `models_cache.json`。

### 界面

- 浅色、深色、跟随系统主题。
- 固定表格布局、实时任务状态和日志、模型目录按需加载。

## 快速开始

推荐使用 Node.js 22.19.0；NVM 用户可先执行 `nvm use`。

```bash
npm ci

# 开发：API :8722 + Vite :5173 热更新
npm run dev

# 生产：构建前端后由后端直接托管
npm run build
npm start
```

开发页面为 <http://127.0.0.1:5173>，直接运行生产服务默认打开 <http://127.0.0.1:8722>。

`npm start` 默认仅监听 `127.0.0.1:8722`。需要局域网访问或常驻运行时，请按部署文档配置监听地址和进程服务，不要依赖 Codex 等自动化工具的会话维持生产进程。

## 部署（常驻 + 开机自启）

- [Linux：systemd 用户服务 / 系统服务 / PM2 / nohup](docs/deploy-linux.md)
- [Windows：PM2 + pm2-windows-startup](docs/deploy-windows.md)

Linux 单机部署推荐使用 **systemd 用户服务**，Windows 沿用 PM2。仓库中的 `ecosystem.config.cjs` 是通用 PM2 配置；本机 systemd 实例文件包含具体路径，不纳入版本控制。

PM2 与文档中的 systemd 示例均监听 `0.0.0.0:8123`，仅在受信内网使用。

## 工作原理

连接方式与执行环境分别解析：`exec.mjs` 只启动本机进程或 SSH；`hostShell.mjs` 识别目标平台并选择 Bash/PowerShell；`hostFiles.mjs` 处理目标路径、三态读取、备份、原子写入和二进制流传输。安装器只分 Windows/Bash 两种实现。

| 环节 | Windows（本机 / SSH） | Linux（本机 / SSH） |
| --- | --- | --- |
| 执行器 | 本机 `pwsh`；SSH 按探测或覆盖使用 `pwsh` / `powershell`，脚本采用 `-EncodedCommand` | `bash -c`；SSH 编码脚本放入命令参数，stdin 留给文件内容 |
| node/npm 定位 | 系统 PATH；SSH 补齐目标机机器/用户 PATH | 自动 prepend `~/.nvm/versions/node/*/bin`，并使用主机 prelude |
| 文件传输 | 本机文件流；SSH PowerShell 原始 stdin 流 | 本机文件流；SSH Bash 原始 stdin 流 |
| 独立安装 / 清理 | Windows 实现 | Linux 实现 |

macOS 支持检查、探测、npm 更新、配置写入、重启和 PATH 修复；当前独立安装与清理依赖 GNU/Linux 工具，能力入口会拒绝这两项操作。技术支持范围不改变 `enabled`、`blocked` 或 `duplicateOfLocal`。

### 非标准环境与代理

若某主机 NVM 不在默认 HOME，或 npm 需要代理，可在页面“编辑”中配置 Shell prelude，例如：

```bash
export NVM_DIR=/path/to/your/nvm
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
source <(curl -sSL https://example.com/setup_proxy.sh) >/dev/null 2>&1 || true
```

## 目录结构

```text
server/
  index.mjs       API / SSE / 静态托管
  hosts.mjs       主机清单、屏蔽与同机禁用
  tools.mjs       检查 / 更新 / 重启 / catalog 推送
  install.mjs     独立安装、版本与资产解析、自动更新配置
  maintenance.mjs 清理与 PATH 修复
  catalogs.mjs    模型 catalog 存储、校验、合并与优先级管理
  exec.mjs        进程与 SSH 传输（标准流、超时、取消）
  hostShell.mjs   运行时解析与 Bash / PowerShell 执行
  hostFiles.mjs   目标路径、读取、备份、原子写入与文件流传输
  capabilities.mjs 操作能力表与统一入口校验
  store.mjs       data/config.json 与 state.json 持久化
  tasks.mjs       任务与实时日志
src/              React 前端（主机管理 / 模型目录）
data/             运行时配置、状态与模型目录（不入库）
```

## 安全

- 本工具能以部署用户身份在本机及 SSH 主机执行命令，不提供身份认证。**仅在受信内网使用，切勿暴露公网。**
- `npm start` 默认只绑定 `127.0.0.1`；PM2 与文档中的 systemd 示例绑定 `0.0.0.0:8123`，应同时限制网络访问范围。
- SSH 使用 `~/.ssh/config` 的既有配置与免密登录（`BatchMode=yes`），不存储密码。可显式覆盖 shell 为 `pwsh`、`powershell` 或 `bash`。
- 远程 Windows 调用会合并注册表机器/用户 PATH 与 SSH 当前 PATH，仅影响当次子进程。

## 开发与测试

```bash
npm run typecheck                  # 前端 TS 检查
node --test server/*.test.mjs       # 后端测试
npx playwright install chromium    # 仅 macOS 首次运行前安装；Windows/Linux 使用系统浏览器
npm run smoke:ui                   # 仪表盘 UI 冒烟（需先启动服务）
node scripts/ui-smoke-catalogs.mjs # 模型目录页 UI 冒烟（需先启动服务）
```

后端测试包含四组运行时契约（本机 Windows/Linux、SSH Windows/Linux）、文件传输失败与权限回归，以及 Bash/zsh 的 PATH 幂等验证。Linux 测试中的 SSH 以本机 shell 回环执行命令，不连接真实主机；Windows 契约测试不替代 Windows 实机安装验证。

UI 冒烟在 Windows 使用系统 Edge、Linux 使用系统 Chrome；其他平台使用 Playwright Chromium。
