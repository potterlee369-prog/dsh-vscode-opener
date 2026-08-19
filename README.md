# dsh-vscode-opener

DSH Web 插件:在对话界面一键用 VS Code 或资源管理器打开**当前会话的工作目录**,同时注册 `/vscode` 斜杠命令。

- **输入栏按钮**:composer 左侧扩展槽里并排放置 VS Code 和资源管理器两个按钮。VS Code 按钮使用**VS Code 官方应用图标**(Microsoft 品牌素材 stable 版,与安装的 VS Code 图标一致;原 SVG 存于 `assets/vscode-stable-official.svg`),另一个使用文件夹图标;点击即把当前会话目录交给宿主进程打开;**静默执行,不会在对话中产生任何命令行**;成功后图标短暂变绿,失败变红并在 tooltip 中显示原因。
- **`/vscode` 命令**:注册到宿主命令注册表(全局),在输入框输入 `/vscode` 或从 `/` 菜单选择,同样生效;可带可选路径参数 `/vscode path/to/dir`(相对路径基于会话 cwd 解析)。与按钮不同,命令执行的结果作为持久的 `command/run` / `command/done` 流程节点显示在对话中。

## 安装

```powershell
# 1. 安装到 web profile(link: 方式,源码改动即时生效,无需重新 add)
dsh plugin --profile web add "E:\dsh_custom\dsh-vscode-opener"

# 2. 在 C:\Users\<you>\.dsh\profiles\web\cordis.patch.yml 中挂载该行:
#    - insert:
#        - id: vscode-opener
#          name: dsh-vscode-opener
#          config:
#            codeCommand: code
#            reuseWindow: false

# 3. 重启 dsh web
```

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `codeCommand` | `code` | 启动命令。裸名称(如 `code`)会先在 PATH 上探测,Windows 下再依次探测 `%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe`、`%ProgramFiles%\Microsoft VS Code\Code.exe`、`%ProgramFiles(x86)%\Microsoft VS Code\Code.exe`;也可配置为完整路径,如 `C:\Users\you\AppData\Local\Programs\Microsoft VS Code\Code.exe` |
| `reuseWindow` | `false` | 为 `true` 时传 `-r`,在最近使用的窗口打开而非新开窗口 |

## 工作原理

- **宿主半侧**(`src/index.ts`):通过 `ctx.commands.register()` 注册 `/vscode` 命令,处理器从 `invocation.agent.session.header.cwd` 取会话工作目录,用 `child_process.spawn`(`detached` + `stdio: 'ignore'` + `unref()`)脱离式启动 VS Code;同时注册 `/plugin/dsh-vscode-opener/launch`、`/plugin/dsh-vscode-opener/open-explorer` 两个静默路由和 `/plugin/dsh-vscode-opener/icon` 图标路由。
- **客户端半侧**(`src/client/index.tsx`):在 `conversation.input.left` 槽位注册两个并排按钮,点击后直接 `fetch` 对应的**静默启动路由**。因为绕开了命令运行时(`CommandRuntime.execute` 会无条件记录 `command/run` / `command/done` 生命周期事件),按钮点击**不会在对话里留下任何命令行**;只有手动输入的 `/vscode` 才走命令通道并显示结果行。
- 构建产物必须符合 Web 模块系统的 lazy-CJS 契约:`lib/client.js` 是 `window.__ModuleLoader__.load({ id, factory })` 包装的经典脚本,工厂函数返回 `{ apply, inject }`,CSS 在工厂物化时注入 `<style data-plugin-css>`。

## 开发循环

```powershell
cd E:\dsh_custom\dsh-vscode-opener
npm install        # 首次
node build.mjs     # esbuild 打宿主/客户端 bundle + tsc 生成 d.ts
node smoke-test.mjs      # 端到端冒烟:真的会打开 VS Code
node client-smoke.mjs    # 验证客户端 bundle 的工厂形态
```

改完代码后 `node build.mjs`,然后**重启 `dsh web`**(宿主行与客户端 bundle 都在启动时扫描/哈希)。link: 安装意味着无需重新 pnpm add。

## 注意事项

- 重启才生效:客户端插件清单在 `dsh web` 启动时扫描,`/plugins/dsh-vscode-opener/client.js` 的 hash 也取启动时快照。
- `/vscode <路径>` 的参数会原样解析后交给 `code`;局域网可信客户端本就有完整 API 权限,本插件不额外收紧,亦不额外放宽。
- 仅 web profile 验证过(按钮需要 Web 界面);headless 下 `/vscode` 命令本身可用,但没有按钮。
