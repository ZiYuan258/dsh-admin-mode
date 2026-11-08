# 维护记录（CHANGELOG）

本插件不走上游仓库、不追外部版本号，只跟着**本机 DSH 运行时**维护。
每次改动的「为什么」都记在这里，避免以后重新踩一遍。

---

## 2026-11-07 —— 跟随 DSH 0.2.2-rc.1 维护

### 1. 修：又一次 computer use 整块消失（同一个坑，第二次踩）

**现象**：DSH 升到 `0.2.2-rc.1` 后 `cua_driver_native__*` 全部消失，
`plugin_manager list_plugins` 里 `include:computer-use` 和
`include:computer-use-cua-driver-native` 都是 `enabled:false, fiberPhase:null`，
但**没有任何 patch 文件把它们 disabled 掉** —— 这个「文件里写着启用、运行时却是关闭」
的矛盾状态，就是启动兼容闸拒绝加载的标志。

**根因**：`dsh-app-boot` 的 `evaluatePluginCompatibility` 会检查包的
`peerDependencies` 里所有 `@deepseek-ai/dsh*` 是否满足当前运行时版本。
`dsh-computer-use@0.2.1-rc.5` 的 peer 锁的是 `@deepseek-ai/dsh-brand@0.2.1-rc.5`，
运行时却是 `0.2.2-rc.1` → 不满足 → `deny()` 把行 `disabled = true`。
这跟 11-04 那次是同一个机制，只是版本号又对不上了。

**改法**：`package.json` 里两个依赖 `0.2.1-rc.5` → `0.2.2-rc.1`，然后 `pnpm install`。

**关键事实（省下次的时间）**：这两个包 rc.5 和 0.2.2-rc.1 的 `lib/index.js`
**逐字节相同**（`diff` 输出为空），变化只在 `peerDependencies`。
所以升级是纯元数据修复，不需要重新审行为。

**验证方式（可复用）**：不要靠肉眼判断兼容性，直接调真闸：
```js
// D:\tmp\compat-022.mjs —— 注意路径要用 file:/// URL，否则 ERR_UNSUPPORTED_ESM_URL_SCHEME
import { evaluatePluginCompatibility, getDshRuntimeVersion }
  from 'file:///D:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'
```
用 `cd /d/dsh && ELECTRON_RUN_AS_NODE=1 "./DeepSeek Harness.exe" --expose-internals D:\tmp\compat-022.mjs`
跑（在 asar 外面用普通 node 读不到这个包）。

### 2. 修：诊断文件里的 `profile=unknown`

**现象**：升级后诊断文件名变成 `dsh_admin_mode_diag.unknown.<pid>.txt`。

**根因**：0.2.2-rc.1 的桌面宿主**不再把 `DSH_PROFILE` 导出到自己的进程环境**里，
只导出给子 shell。插件原来靠 `process.env.DSH_PROFILE` 取 profile 名，于是拿到空值。

**改法**：优先读宿主提供的 `profileContext` 服务
（`ctx.get('profileContext')` → `{ name, dir, ... }`，由 `dsh/lib/profile-boot-*.js`
通过 `hostCtx.provide("profileContext", ...)` 注入），
取不到再退回 `DSH_PROFILE` / `DSH_PROFILE_DIR` 的 basename。
`apply(ctx)` 第一句先 `rememberProfile(ctx)`。

**这条的教训**：环境变量是「碰巧能用」，服务契约才是「保证能用」。
拿不到就问宿主，不要猜环境。

### 3. 复核：0.2.2-rc.1 的宿主 API 全都还在

- `tools.guard(guard)` 仍在（`dsh-tools/lib/index.js`），只是内部实现改成
  `this.guards.effect(this.ctx, (layer) => layer.guards.append(guard), ...)`
- `permissionPresets.current(session)`、`systemPrompt.section()` 都在
- 客户端侧 `conversation.input.permission` 插槽、`permissionPresets/catalog` 远程方法都在
- **变了一个**：`tools.guardReason(exec)` 改名为 `tools.checkGuards(exec)`
  —— 只影响我自己的测试脚手架，不影响插件本体

### 4. 实测（0.2.2-rc.1 真实宿主）

- 两个 computer-use 行恢复 `enabled:true, fiberPhase:"active"`
- `cua_driver_native__*` 工具数 **56**（Cua Driver SDK 仍是 0.28.0，没变）
- 权限菜单能打开，四档齐全，管理员档标「当前」
- 门控在管理员档放行：诊断文件出现
  `mouseGuardAllow=cua_driver_native__click @ admin`

### 5. 事故记一笔：`pnpm install` 之后动 `plugin_manager set_plugin` 会炸掉整个插件树

升级依赖后我为了「顺手刷新一下」调了 `plugin_manager set_plugin`，
结果 12 个插件同时 import 失败（JetHub / dsh-market / 技能 / 侧边栏 / 工作流 / 任务看板 / univer 等），
报错是找 `@deepseek-ai/schemastery/node_modules/@deepseek-ai/cosmokit/lib/index.js`。

**为什么**：`schemastery@3.19.0` 自己依赖 `@deepseek-ai/cosmokit@~1.9.0`，
hoisted 布局下应该由顶层 `cosmokit@1.9.0` 满足；`pnpm install` 重整依赖树时，
嵌套链接没建出来，但顶层那份是好的、`require.resolve` 也能回退到它。
**重启后自然恢复**（进程启动时重新解析模块），所以是「内存里 apply 失败」而不是「配置被改坏」。

**守则**：
1. 不要为了「刷新插件」去调 `plugin_manager set_plugin` —— 它会重挂整棵树，
   任何一个插件的依赖缺失都会牵连所有 import 它的插件；
2. `pnpm install` 之后先跑一次依赖解析自检（下面第 6 条），再碰任何活的东西；
3. 真需要重载宿主半时，优先重启桌面端，别在活进程里重挂。

### 6. 依赖自检脚本（`pnpm install` 之后必跑）

`D:\tmp\depcheck.cjs`：对每个关键插件目录分别 `require.resolve`
`@deepseek-ai/schemastery` 和 `@deepseek-ai/cosmokit`，打印解析到的真实路径。
全部 OK 才说明依赖树是健康的 —— 「嵌套路径不存在」本身不是错，
只要回退到顶层那份能解析就是正常的。

**注意**：在 `ops_bash` 里写 Windows 路径，反斜杠会被 bash 吃掉
（`C:\Users` 变成 `C:Users`，`\n` 变成换行），必须用脚本文件，不要在 `node -e` 里塞路径。

### 7. ★ 纠正一个错了很久的结论：Electron 桌面端 UIA 是**能用**的

**旧结论（错）**：`cua_driver_native__get_window_state` 的 UIA 树只返回最小化/恢复/关闭
三个窗口按钮，所以「Electron 页面元素拿不到，只能截图 + 像素点击」。

**实际**：`get_window_state` 走的是 MCP 那套精简投影，**不是** UIA 的真实能力。
直接 `AutomationElement.FromHandle(132892).FindAll(Descendants, TrueCondition)`
一次返回 **574~603 个元素**，每个按钮都带可读名字，例如：

```
Button  '访问模式，当前：管理员'   (1018, 1338)
Edit    '发消息或创建任务, / 调用指令, @ 文件或对话'   (1414, 1290)
Button  '↻'   (1088, 1338)
RadioButton '管理员 危险 当前 完全访问 + 永不询问…'   (1139, 1265)
```

**代价对比（这才是「慢」的根因）**：

| 做法 | 一轮交互耗时 | 失败率 |
| --- | --- | --- |
| 截图 → `read_image` 降采样 → 肉眼估坐标 → 点错 → 重来 | 30~90 s | 很高（本轮连续点错 3 次） |
| UIA 按名字查坐标 → 直接点 | **1.4~2.6 s** | 低 |

**教训（最重要的一条）**：判断「某个 UI 自动化通道能不能用」时，
**不要拿一个封装工具的行为当结论**。`get_window_state` 不给元素 ≠ 系统 UIA 不给元素。
真验证要用底层 API 直接试一次。

### 8. 新增三个 UI 工具（`D:\Vibe coding\plugin\dsh-admin-mode-fix2\tools\`）

| 文件 | 依赖 | 作用 | 实测耗时 |
| --- | --- | --- | --- |
| `ui.py` | `uiautomation`（Anaconda 已带） | **首选**。`find` / `click` / `list` / `wait`，输出 name/type/cx/cy | 1.4~2.6 s |
| `uia.ps1` | 无（走 .NET UIAutomationClient） | 同功能，无第三方依赖时用 | 2.8~3.8 s |
| `ui.ps1` | 无（WinRT OCR zh-Hans-CN） | 抓屏 + OCR，输出「文字 + 真实屏幕坐标」，用于 UIA 拿不到的 canvas / 视频区 | 3.1 s |

**为什么 `ui.py` 比 PS 版快一倍**：`powershell -NoProfile` 冷启动就要 702 ms，
加载 UIA 程序集后 987 ms —— 这段开销无论怎么优化脚本都躲不掉。

**两个踩过的坑**：
1. `ui.ps1` 文件**必须带 UTF-8 BOM**。不带的话 PowerShell 按 GBK 解码中文注释，
   注释里的引号会提前终止字符串，报 `Unexpected token '}'`。
2. WinRT 的 `InMemoryRandomAccessStream` 在 PowerShell 里 `New-Object` 不出来，
   必须走 `StorageFile.GetFileFromPathAsync` + `OpenAsync`。

**`ui.py` 的匹配排序必须按「前缀优先 + 名字短优先 + 面积小优先」**：
只按面积排会匹配到聊天记录里的长消息（本轮就匹配到了自己写的话，
`'思考 Very interesting! The permission chip now reads…'`），而不是真控件。

### 9. 实测：权限档切换的完整闭环（handoff 3.1 的两个缺口都已补上）

- **降档**：菜单 →「仅可查看」→ 芯片变 `访问模式，当前：仅可查看`（UIA 直读，不是看图）
- **升档至管理员**：两次严重警告
  - 第一道「严重警告 1/2 · 将交出整台电脑」，复选框「我已了解，这只是第一次确认」，
    按钮「取消」/「继续（还有一次确认）」
  - 第二道「严重警告 2/2 · 自主执行 + 大量消耗 tokens」，复选框「我确认启用管理员模式」，
    按钮「取消」/「启用管理员」
  - 走完后芯片变 `访问模式，当前：管理员`，菜单里该行的
    `SelectionItemPattern.IsSelected === true`
- **门控拒绝（关键证据）**：在 read-only 档下点 `cua_driver_native__move_cursor`，返回
  `电脑操作（鼠标/键盘/剪贴板/窗口/应用控制）仅限「管理员」权限档：当前权限档是「read-only」，已拒绝执行 cua_driver_native__move_cursor`
  诊断文件同步写入 `mouseGuardDeny=cua_driver_native__move_cursor @ read-only`
- **门控放行（对照）**：管理员档下同样调用 → `mouseGuardAllow=cua_driver_native__move_cursor @ admin`

**现象记录（重要，别误判成 bug）**：刚从 read-only 恢复时，UIA 读芯片会短暂返回旧值
（先是「仅可查看」，几秒后才是「管理员」），而诊断文件里门控**已经**按 admin 放行了。
说明「门控看的是宿主内存里的当前档位」与「UIA 读到的 DOM 文本」是两个更新节奏，
**判断真档位以门控的 `mouseGuardAllow … @ <preset>` 为准**，DOM 文字会慢一拍。

### 10. 事故记一笔：把主会话自己切成 read-only，等于自锁

为了验证「降档真的生效」，我直接在**当前正在干活的会话**里点了「仅可查看」。
后果是三重锁死：

1. `cua_driver_native__*` 全部被自己的门控拒绝 → 鼠标键盘都没了
2. **Chromium 的 UIA 树塌缩**：`GetRootControl()` 只剩 `PaneControl '桌面'` 0 个子节点，
   `ElementFromHandle(132892).FindAll(Descendants)` 只剩 **2** 个元素，
   COM `FindAll` 甚至会挂死 >120 s。Chromium 在没有活跃 UIA 客户端时会收起无障碍树，
   冷查询拿不到东西。
3. **文件写入全禁**：`tempfile.gettempdir()` 抛
   `FileNotFoundError: No usable temporary directory found`（连 `%TEMP%` 都不可写），
   PowerShell `Add-Type` 抛 `Access to the path '...\vw5gfpuw.tmp' is denied`，
   PIL `save` 抛 `PermissionError`。

**唯一活着的退路**：`ops_bash` 本身。但 `SendInput` 也被拒（光标纹丝不动），
只有 `SetCursorPos` + `mouse_event` 能真的移动并点击 —— 也就是说
「raw 输入」在 read-only 下并非全封，但**不要指望这条退路自动化**，当时的实际选择是让用户手动切回来。

**守则**：
1. **永远不要在正在干活的会话里降档**。要测切档，开一个新会话去测。
2. 如果已经在低档位里，判断依据用诊断文件的 `mouseGuardAllow/Deny` 行，
   不要依赖 UIA（它可能已经塌缩）。
3. 恢复后 DOM 文本会滞后几秒，别急着判定「没切成功」并重复点击。

---

## 2026-11-04 —— 跟随 DSH 0.2.1-rc.5 维护

### 1. 修：computer use 整块消失（依赖版本没跟上运行时）

**现象**：DSH 升到 `0.2.1-rc.5` 之后，`cua_driver_native__*` 工具全部消失，
`plugin_manager list_plugins` 里两行是
`enabled:false, fiberPhase:null`，但 patch 文件里没有任何 `disabled: true`。

**原因**：`package.json` 把两个 computer-use 包钉在 `0.2.1-rc.3`，而这两个包的
`peerDependencies` 里锁了 `@deepseek-ai/dsh-brand@0.2.1-rc.3`。启动兼容闸
（`@deepseek-ai/dsh-app-boot` 的 `unmetRequirements` / `evaluatePluginCompatibility`）
比对到运行时是 `0.2.1-rc.5`，peer 不满足 → 直接把插件行 `disabled = true`，
**界面上不报错、日志里也没有**，表现就是「东西没了」。

**改法**：`dependencies` 从 `0.2.1-rc.3` → `0.2.1-rc.5`，`pnpm install` 后重启。
`diff` 过两个版本的 `lib/index.js`：**完全相同**，所以这次升级不涉及行为变化，
纯粹是元数据修复。

**教训**：DSH 升级后先查依赖版本，不要先去怀疑代码。

### 2. 修：鼠标门控从「8 个名字白名单」改成「默认拒绝」

**现象**：旧实现只列了 8 个鼠标工具名（`click` / `drag` / `scroll` / `move_cursor` …）。
实际 CUA SDK 0.28 暴露 **56 个**工具，`type_text` / `press_key` / `hotkey` /
`set_value` / `clipboard_write` / `launch_app` / `kill_app` / `set_window_frame` /
`invoke_menu` / `browser_*` 写入类全部漏网 —— 非管理员档也能敲键盘、改剪贴板、杀进程。

**改法**：改成前缀判断 `cua_driver_native__*` + 只读白名单（`CUA_READONLY`），
除白名单外一律要「管理员」档。以后 CUA 再加工具，默认就是被拦住的。

**只读白名单为什么要包含 `start_session` 等会话句柄**：截图流程必须先
`start_session` 拿句柄，把句柄类也拦掉会让「看一眼屏幕」直接不可用。

**验证**：`verify-guard2.mjs`（65 个用例）在真实 host 里跑：
56 个 cua 工具逐个过 guard，非管理员档全部 DENY；old 版实现同一套用例 `50 PASS / 15 FAIL`，
差的正好是新覆盖的那 15 个。

### 3. 修：诊断文件被多个 profile 互相覆盖

**现象**：调试时桌面端的诊断内容突然变成探针 profile 的，导致结论不可信。

**原因**：`writeDiag` 固定写 `%TEMP%\dsh_admin_mode_diag.txt`，所有 profile、所有进程共用一个文件。

**改法**：文件名带上 `profile` 和 `pid`
（`%TEMP%\dsh_admin_mode_diag.<profile>.<pid>.txt`），同时保留一份
`dsh_admin_mode_diag.txt.latest`（末尾写 `profile=` / `pid=`）方便人直接看最新一份。

### 4. 修：自检熔断会永久藏掉权限菜单（历史遗留，本次确认并固化）

早先版本里「visual overlay」和「权限菜单控件」共用一个 `adminUiDisabled` 开关，
开机探测一旦抢先失败就把控件永久 return null，用户看到的就是「权限选择没了」。
现在两者分开：`overlayDisabled` 只关屏幕提示层，控件永不熔断；
探测也从 2 次（1.5s / 4s）加到 3 次（1.5s / 4s / 8s），必须连续失败才熔断视觉层。

### 5. 修：安装副本和源码目录不是同一个文件（「改了没生效」的真凶）

**现象**：`index.js` 明明改完、语法自检也过了，可宿主行为没变；
诊断文件里还是旧内容，甚至还是旧的固定文件名。

**原因**：`%USERPROFILE%\.dsh\plugins\dsh-admin-mode\`（源码目录，我改这里）和
`%USERPROFILE%\.dsh\profiles\desktop\node_modules\@local\dsh-admin-mode\`
（宿主真正加载的安装副本）**不是同一份**：两者 inode 不同，`diff` 直接 DIFFERENT。
只有 `package.json` / `README.md` / `cordis.patch.yml` / `LICENSE` / `icon.svg` 是硬链接，
而 `index.js`、`client.js`、`docs/`、`locale/` 都是各走各的副本。
所以之前几次修改只落在源码目录，宿主一直在跑 10-23 的旧代码。

**改法**：把安装副本整个挪到 `.maintenance/installed-copy-before-junction-20261104`，
再用目录联接重建：

```
mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\@local\dsh-admin-mode" ^
         "%USERPROFILE%\.dsh\plugins\dsh-admin-mode"
```

之后 `cmp` 两个路径下的 `index.js` / `client.js` 都是 `SAME`，
`plugin_manager` 关开一次这一行就真正加载到新代码（诊断里出现新的
`mouseGuardCalls=<数字>` / `mouseGuardLast=<工具名>` 即为证据）。

**教训**：改完插件先验证「宿主加载的那份文件确实是我改的这份」，再谈行为。
只比对源码目录里的文件是没有意义的。

### 6. 改：门控诊断从 `ok/fail` 改成带真实取值

`mark(name, ok)` 只能写 `name=ok` / `name=fail`，于是 `mouseGuardLast` 里
工具名整个丢掉、`mouseGuardCalls` 里次数也丢掉，从诊断文件根本看不出是哪个工具触发的。
新增 `note(key, value)`（同样写进诊断、同样做换行截断），门控改成记
`mouseGuardCalls=<次数>`、`mouseGuardLast=<工具名>`、
`mouseGuardDeny=<工具名> @ <权限档>`、`mouseGuardAllow=<工具名> @ admin`。

### 7. 文档

- README 的 `0.2.1-rc.2` 全部改成 `rc.5`，并写清「版本必须与运行时一致」的原因
- README 里「`cua_driver_native__*` 可能绕过 `tools.guard`」的旧结论**已删除**：
  2026-11-04 在 rc.5 真实宿主里实测，guard 是被调用的、也是生效的
- `docs/preview.png` 之前是 0 字节（README 里一直是坏图），已用当天实拍替换
- README 安装章节新增「装完一定要确认安装副本真的是联接」的核对步骤
- 新增本文件

---

## 维护守则

1. **跟着运行时走**：DSH 升 rc，先升两个 computer-use 依赖，再谈其它
2. **默认拒绝**：新增能力默认被拦，只把真正只读的加进白名单
3. **不许只改代码就交付**：Host 半要在真实 host 里用 guard 实测，Client 半要在真实界面里截图确认
4. **改动要留「为什么」**：这个文件就是为此存在的
