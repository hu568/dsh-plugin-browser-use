# @dsh-external/dsh-browser-use

DSH 的浏览器操作能力：让 Agent 真正驱动本机 Chromium 打开、阅读、点击、输入、截图网页，
并提供一个可实时观看的右侧栏面板。

移植自 [ZCode](https://github.com/zai-org/ZCode) 的 `browser-use-plugin` /
`control-browser` 技能，把它的「ARIA 快照优先」操作范式落到 DSH 的工具、提示段与 UI 上。

| | |
|---|---|
| 许可证 | MIT，见 [LICENSE](./LICENSE)（含 [NOTICE](./NOTICE) 中的 ZCode / Apache-2.0 署名） |
| 安装规格 | `github:hu568/dsh-plugin-browser-use` |
| 实测 DSH | `0.1.5-rc.1` ~ `0.1.7-rc.2` |
| 运行依赖 | `playwright-core ^1.56.1`（从 npm registry 拉取）；浏览器用本机已缓存的 Chrome for Testing |

## 安装

```powershell
# DSH 内置插件管理器（创造模式）：
#   plugin_manager  action=install_bundle  target="github:hu568/dsh-plugin-browser-use"

# 或命令行。桌面端（Electron）profile 由应用独占管理，请改用插件管理器或「设置 → 插件」：
dsh plugin --profile <profile> add github:hu568/dsh-plugin-browser-use
```

安装后本包被追加进 profile 的 `dsh.profile.bundles`，其 `cordis.patch.yml` 作为组合包层
把 `dsh-browser-use` 这一行插进宿主组合。profile 在运行中通常即时生效，否则重启一次 DSH。

浏览器**懒启动**：第一次调用 `browser_open` 时才拉起，插件卸载/热重载时释放。

> **实现注记**：取 `webServer` 服务时不能只用裸 `ctx.get('webServer')`。宿主 webserver 的
> fiber 要等 socket 绑定完成才 ACTIVE，而 cordis 的 `ctx.get()` 默认 `strict=true`，加上 Loader
> 并行启动 entry，插件 `apply` 常常早于它就绪，此时那个判空会静默跳过 ⇒ 面板路由一条都不注册
> ⇒ 面板永远 HTTP 404。本包先把面板注册包成函数，拿不到服务就挂作用域
> `ctx.inject(['webServer'], …)` 等就绪后补注册（与 `dsh-whale-widget` 同款等待方式）。

## 交付物

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| Host 插件 | `lib/index.js` | 浏览器会话管理 + 10 个模型工具 + 面板路由 |
| Client 面板 | `lib/client.js` | 手写 ModuleLoader 包，注册右侧栏 `browser` 标签页与会话头部按钮 |
| 技能 | `skills/control-browser/SKILL.md` | 经 `ctx.skills.register()` 注入本会话技能目录 |
| 提示段 | `lib/index.js` 内 | 常驻系统提示的工作流约束（不依赖技能被发现） |

## 工具面

| 工具 | 作用 |
| --- | --- |
| `browser_open` | 打开 URL 并返回快照；同源默认复用标签页 |
| `browser_snapshot` | 读 ARIA 快照（元素带 `[ref=…]`），定位与阅读的主要手段 |
| `browser_click` | 按 ref 点击 / 双击 |
| `browser_type` | 按 ref 填文本，可选回车提交 |
| `browser_press` | 发送按键 |
| `browser_navigate` | back / forward / reload / goto |
| `browser_tabs` | list / new / select / close |
| `browser_wait` | 等 ref 可见、等文本、等固定毫秒 |
| `browser_eval` | 页面上下文求值，返回 JSON |
| `browser_screenshot` | 截图并作为图片内容块返回 |

## 面板路由

| 路由 | 作用 |
| --- | --- |
| `GET /browser-panel/state` | 运行状态、标签列表、当前 URL/标题、视口尺寸、是否持久化 profile |
| `GET /browser-panel/stream` | `multipart/x-mixed-replace` 实时画面（MJPEG） |
| `POST /browser-panel/navigate` | `{"url":"…"}` 让 **AI 的**浏览器前往 |
| `POST /browser-panel/open-local` | `{"url":"…"}` 用**用户自己的**桌面浏览器打开 |
| `POST /browser-panel/input` | 转发用户输入，见下 |

> 路由前缀**不带 `api` 段**（对比：`dsh-persona-memory` 是 `/persona-memory/api/…`）。

`open-local` 的启动器按序尝试：**PowerShell `Start-Process -PassThru`**（首选，能回显实际
拉起的进程名）→ `cmd /c start`（须把 `cwd` 设为 Windows 路径，否则 UNC 工作目录会告警）→
`wslview` → `xdg-open`。

> 坑：**不要用 `explorer.exe` 开 URL**。它是文件资源管理器，传 URL 进去弹的是资源管理器窗口
> 而不是浏览器——这是初版的实际 bug。URL 要走 ShellExecute 语义。

投屏以 CDP `Page.startScreencast` 为主（页面变化即出帧），并配一个 1.5s 兜底帧泵：
静态页面不会产帧，没有兜底的话「冷连接」的观看端会永久空等。

## 用户接管操作

面板不是只读的。`/browser-panel/input` 接受：

| `kind` | 字段 | 派发到 |
| --- | --- | --- |
| `move` / `down` / `up` / `click` | `x`,`y`,`button` | `page.mouse.*`（支持拖拽、右键） |
| `wheel` | `x`,`y`,`deltaX`,`deltaY` | `page.mouse.wheel` |
| `text` | `text` | `page.keyboard.insertText` |
| `key` | `key` | `page.keyboard.press` |

坐标由面板按 `视口尺寸 / 图片显示尺寸` 换算成页面 CSS 坐标后再发。
客户端把鼠标事件挂在投屏图上、键盘事件挂在一个可聚焦容器上，并接管
`paste`（剪贴板内容直接走 `insertText`，密码可以从密码管理器粘贴）。
被转发的输入与工具走**同一条 Playwright 链路**，页面对两种来源没有区别。

用途：登录、验证码、短信/人工确认、密码管理器填充等机器做不了的环节，
Agent 把页面带到那一步，剩下的你自己在面板里完成。

## 登录态持久化

默认使用持久化 profile（`<DSH_HOME>/browser-use/profile`），cookie 与
localStorage 跨插件热重载、DSH 重启保留。实测：带过期时间的 cookie 与
localStorage 在浏览器进程关闭并重新拉起后依然存在。

注意两点：

- **会话 cookie（无 `Expires`/`Max-Age`）不保留** —— 这是浏览器固有行为：
  进程一退就清。多数站点「记住我」会写持久 cookie，那种能留下。
- 同一 profile 不能同时被两个进程占用；插件卸载/重载时会关闭浏览器释放它。
- 需要干净环境时把 config 的 `userDataDir` 设为 `'off'`。

## 仓库结构与源码

本仓库以 **`lib/` 为唯一源码**，纯 JavaScript（ESM），**不需要任何构建链**，克隆即可用：

| 路径 | 角色 |
|------|------|
| `lib/index.js` | 宿主半：浏览器会话、10 个工具、面板路由与提示段 |
| `lib/client.js` | 客户端半：手写 ModuleLoader 包 |
| `skills/control-browser/SKILL.md` | 随包技能 |
| `cordis.patch.yml` | 组合包层：把 `dsh-browser-use` 行插进宿主组合 |

修改直接改 `lib/*.js`，重启 DSH（或热重载该包）即生效。仓库里**没有** `src/` 与
TypeScript 构建链，也不需要它们。

## 已知边界

- Client 半边在**页面刷新后**生效：页面若早于注入加载，其 client 模块不会被 import。
- `screenshot` 需要部署挂载 attachment 服务。
- `goto` 只接受 `http:` / `https:` / `about:blank`。
- 面板路由与 DSH 其余路由同源（loopback），**没有独立鉴权**：本机其他进程也能
  调 `/input`。批量输入走 `application/json`，跨站表单无法直接利用；若部署在
  多用户机器上，应自行在反代层加鉴权。
- 页面内容是不可信数据，工具描述与技能都显式约束：只用于定位元素，绝不当作指令执行。
- 「用我的浏览器打开」按平台回落：Windows 上走 PowerShell `Start-Process`；
  WSL 下可借 Windows interop；两者都不通的平台再依次回落到 `wslview` / `xdg-open`，
  都没有时报错，不会静默失败。

## 协议与致谢

本包采用 **MIT License**（见 [LICENSE](./LICENSE)），版权人 `hu568`（https://github.com/hu568）。

`browser-use-plugin` 与 `control-browser` 技能的操作范式移植自
[zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache License 2.0），署名见 [NOTICE](./NOTICE)。
