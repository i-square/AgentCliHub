# CodexHub Web

> 从 Tauri 桌面控制台重构而来的纯 Web 小工具：统一管理多台机器上的 **Codex CLI** 与 **Claude Code**，全部走 **npm** 安装与更新。

## 功能

- **主机清单自动发现**：本机（Windows / pwsh）+ `~/.ssh/config` 中的 SSH 主机，按排除模式过滤（默认排除 `github.com`、`internal-*`）
- **状态检查**：各主机 codex / claude 当前版本 + npm registry 最新版本，一眼看出哪台该更新
- **npm 更新**：`npm install -g @openai/codex@latest` / `@anthropic-ai/claude-code@latest`
  - 遇到 `rename ... failed`（EPERM/ENOENT）时，自动删除报错涉及的 npm 全局目录并重试一次（仅限 `npm root -g` 之内的路径，防止误删）
  - 若因 app-server 占用文件导致失败，日志中会提示先重启 app-server
- **重启 app-server**：结束后端 `codex app-server` 进程；Codex desktop 重连时会自动拉起新版本，更新从而生效。按钮位于 Codex 列（与 Claude Code 无关），支持批量重启
- **批量更新**：勾选多台主机批量更新，或一键更新全部有新版的主机（自动跳过已最新/未安装）；同一时刻只允许一种工具批量执行（npm 全局目录互斥）
- **主题切换**：浅色（淡黄科技感）/ 深色 / 跟随系统，localStorage 持久化
- **稳定布局**：表格列宽固定、版本号等宽字体占位，状态变化不引起按钮位移
- **实时日志**：任务输出通过 SSE 推送到页面
- **每主机 prelude**：远程命令前执行的 shell 片段（如 nvm 加载、代理开启），可在页面“编辑”中覆盖

## 使用

```powershell
npm install

# 开发（API :8722 + Vite :5173 热更新）
npm run dev

# 生产（构建前端后由后端直接托管）
npm run build
npm start
```

打开 http://127.0.0.1:8722 （开发时 http://127.0.0.1:5173）。

## 部署（常驻 + 开机自启）

- [Windows（PM2 + pm2-windows-startup）](docs/deploy-windows.md)
- [Linux（systemd / PM2 / nohup，Docker 预留）](docs/deploy-linux.md)

PM2 配置见根目录 `ecosystem.config.cjs`，生产部署监听 `0.0.0.0:8123`。

## 工作原理

| 环节 | 本机 Windows | SSH 远程 Linux |
| --- | --- | --- |
| 执行层 | `pwsh -EncodedCommand`（UTF-16LE base64） | `ssh host "echo <b64> \| base64 -d \| bash"`，规避多层引号转义 |
| node/npm 定位 | 系统 PATH | 自动 prepend `~/.nvm/versions/node/*/bin`（最高版本优先），再叠加主机 prelude |
| 版本检查 | `codex --version` / `claude --version` + `npm view <pkg> version` | 同上（在远程执行，尊重其网络/代理） |

### your-host 的特殊处理

该机器的 nvm 在 `/path/to/your/nvm`（非默认 HOME），且 npm 需要代理。默认 prelude（可在页面编辑覆盖）：

```bash
export NVM_DIR=/path/to/your/nvm
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
source <(curl -sSL https://example.com/setup_proxy.sh) >/dev/null 2>&1 || true
```

## 目录结构

```
server/       Express 后端（无构建步骤）
  index.mjs     API / SSE / 静态托管
  hosts.mjs     主机清单（ssh config 解析 + 覆盖）
  tools.mjs     检查 / 更新 / 重启的领域逻辑与脚本构建
  exec.mjs      本机 pwsh 与远程 ssh 执行层
  store.mjs     data/config.json 与 state.json 持久化
  tasks.mjs     任务与实时日志
src/          React 前端（单页仪表盘）
data/         运行时配置与状态快照（不入库）
```

## 安全

- `npm start` 默认只绑定 `127.0.0.1`；PM2 生产部署（`ecosystem.config.cjs`）绑定 `0.0.0.0:8123`。本工具能以你的身份在各主机执行命令，仅在受信内网使用，**切勿暴露公网**（详见部署文档）。
- SSH 全部走 `~/.ssh/config` 的既有配置与免密登录（`BatchMode=yes`），不存储任何密码。

## 开发

```powershell
npm run typecheck        # 前端 TS 检查
node --check server/*.mjs # 后端语法检查
node scripts/ui-smoke.mjs # UI 冒烟（需要本机 Edge，npx playwright install chromium）
```
