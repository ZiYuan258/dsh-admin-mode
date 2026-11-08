/**
 * dsh-admin-mode — Host half.
 *
 * 职责：
 *  1. 鼠标门控：非「管理员」档一律拒绝鼠标类工具（guard，单调拒绝）
 *  2. 「自己完成所有操作」规则注入（多通道保底）
 *  3. 鼠标状态路由（给 client 的操控提示用）
 *
 * ★ 没有强制依赖任何宿主服务：某个服务不存在时，其它功能照常工作。
 *   包内**不 spawn 任何外部程序**（没有 Python / exe）。
 */
export const inject = []

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** ★ 2026-11-04 维护：cua driver 0.28 暴露 56 个工具，旧实现只白名单 8 个鼠标名，
 *  type_text / hotkey / press_key / set_value / clipboard_write / launch_app / kill_app /
 *  set_window_frame / invoke_menu 等「真能改变你桌面」的动作全部漏掉。
 *  改为：除只读探测类之外，`cua_driver_native__*` 一律要「管理员」档。
 *  这样以后 cua 再新增工具，默认也是被拦住的（默认拒绝，而不是默认放行）。 */
const CUA_PREFIX = 'cua_driver_native__'

/** 只读 / 无害：列窗口、读状态、截图、读无障碍树、会话句柄本身，不改变桌面。 */
const CUA_READONLY = new Set([
  'list_apps',
  'list_windows',
  'get_window_state',
  'verify_state',
  'debug_window_info',
  'get_screen_size',
  'get_desktop_state',
  'get_cursor_position',
  'get_agent_cursor_state',
  'check_permissions',
  'health_report',
  'get_config',
  'get_accessibility_tree',
  'zoom',
  'page',
  'get_browser_state',
  'get_recording_state',
  'clipboard_read',
  // 会话句柄：只拿到/查看会话，不动用户屏幕。截图前必须先 start_session，因此不能拦。
  'start_session',
  'get_session',
  'list_sessions',
  'get_session_state',
  'end_session',
])

const isCuaTool = (name) =>
  typeof name === 'string' && name.startsWith(CUA_PREFIX)

/** 需要「管理员」档的电脑操作：cua 工具里除去只读探测类的全部。 */
const isGatedTool = (name) =>
  isCuaTool(name) && !CUA_READONLY.has(name.slice(CUA_PREFIX.length))

/** ★ 插件核心规则：自己完成所有操作。
 *  单独抽出来，便于在多个通道里重复注入（任一通道可用即生效）。 */
const SELF_DONE_RULE =
  '管理员模式核心规则：所有操作由你自己完成并验证 —— 打开程序、点击、输入、测试、截图、读日志、' +
  '自查 DOM/接口全部自己做；不把操作或测试交给用户，用户只做最后验收。' +
  '没自测通过之前不许说"好了"；插件类改动必须自己触发一次真实操作、自己看到效果才算完成。'

/** 当前 profile 名。
 *
 * ★ 2026-11-07：DSH 0.2.2-rc.1 的桌面宿主不再把 DSH_PROFILE 放进自己的进程环境
 *   （只有它 spawn 出来的 shell 子进程才有），诊断文件名一度变成 ...unknown.<pid>.txt。
 *   现在优先用宿主 provide 的 profileContext（profile-boot 里 hostCtx.provide('profileContext', …)），
 *   环境变量只作后备。 */
let diagCtxProfile = ''
const pathBasename = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
const rememberProfile = (ctx) => {
  try {
    const info = ctx && typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined
    if (info && typeof info.name === 'string' && info.name.length > 0) {
      diagCtxProfile = info.name
    } else if (info && typeof info.dir === 'string' && info.dir.length > 0) {
      diagCtxProfile = pathBasename(info.dir)
    }
  } catch {
    // profileContext 可能还没就绪：留空，走环境变量后备
  }
}
const diagProfile = () => diagCtxProfile

/** 写一份通道诊断，别人机器上出问题时能直接看。
 *
 * ★ 2026-11-04：原来固定写 %TEMP%\dsh_admin_mode_diag.txt，所有 profile、
 *   所有进程共用一个文件 —— 探针 profile 一启动就把桌面端的诊断覆盖掉，
 *   事后看文件根本分不清是哪个进程写的。现在文件名带上 profile + pid，
 *   同时把最新的那份另存为 dsh_admin_mode_diag.txt.latest 供人快速查看。 */
const writeDiag = (lines) => {
  try {
    const fs = require('node:fs')
    const os = require('node:os')
    const path = require('node:path')
    const dir = os.tmpdir()
    const rawProfile = diagProfile()
      || process.env.DSH_PROFILE
      || (process.env.DSH_PROFILE_DIR ? path.basename(process.env.DSH_PROFILE_DIR) : '')
      || 'unknown'
    const profile = String(rawProfile).replace(/[^A-Za-z0-9_.-]/g, '_')
    const body = lines.join('\n')
    fs.writeFileSync(path.join(dir, 'dsh_admin_mode_diag.' + profile + '.' + process.pid + '.txt'), body)
    fs.writeFileSync(path.join(dir, 'dsh_admin_mode_diag.txt.latest'), body + '\nprofile=' + profile + '\npid=' + process.pid)
  } catch {
    // ignore
  }
}

const channels = []
const mark = (name, ok) => {
  channels.push(name + '=' + (ok ? 'ok' : 'fail'))
  writeDiag(channels)
}
/** 带值的诊断：mark() 只能写 ok/fail，工具名和次数必须用这个才留得下来。 */
const note = (key, value) => {
  const text = String(value === undefined || value === null ? '' : value)
  channels.push(key + '=' + text.replace(/[\r\n]+/g, ' ').slice(0, 120))
  writeDiag(channels)
}

export function apply(ctx) {
  // ★ 2026-10-21：apply 一进来就先落一行「启动时间戳」，
  //   这样重启后看诊断文件就能立刻判断插件到底有没有被宿主加载。
  rememberProfile(ctx)
  channels.length = 0
  channels.push('apply@' + new Date().toISOString())
  writeDiag(channels)

  let guardCalls = 0
  let guardLast = ''

  // ================================================================ 保底 1
  // systemPrompt：宿主有就注入（可选，没有也不影响插件其它功能）
  try {
    ctx.inject(['systemPrompt'], (childCtx) => {
      try {
        childCtx.systemPrompt.section({
          name: 'admin-mode-self-verify',
          order: 42,
          text: [
            SELF_DONE_RULE,
            '操作电脑的优先级：需要打开应用、点击、输入、看屏幕时，优先用 computer use 工具',
            '（cua_driver_native__*）直接操作屏幕，不要写脚本模拟鼠标键盘；只有工具不可用时才回退到脚本。',
            '鼠标使用规范：',
            '（1）只有「管理员」权限档允许鼠标类工具（click / double_click / right_click / drag / scroll / move_cursor）；',
            '其它档位会被直接拒绝，不要尝试绕过。',
            '（2）鼠标必须滑动：用多次 move_cursor 分步移动，每次不超过屏幕宽高的 1/6，通常 3~6 步到目标；',
            '禁止一步跳到目标再点。',
            '（3）能点/能滑的操作不要用脚本注入或坐标硬编码代替；脚本只用于文件处理、构建、渲染等非 UI 任务。',
            '（4）按 ESC 会立刻收掉操控提示并暂停 3 秒，此时不要再重试鼠标动作，把控制权交还用户。',
            '（5）UI / 动画 / 视觉类改动必须逐帧检验（连续截多帧对比），确认没有错位、穿模、闪烁。',
            '（6）完成后有产出（图片、视频、文档、压缩包、exe）时，自动打开所在文件夹并选中该文件',
            '（Windows 用 explorer /select,<路径>）。',
            '（7）管理员档会明显消耗 tokens（自测 + 逐帧验证），开始前先跟用户说明预期。',
            '（8）用户通过「↻ 迭代」按钮发起自主迭代时，对话框里只会出现一条很短的指令',
            '（如「自主迭代 3 轮：方向」）。你要把它当作完整任务：连续跑完指定轮次，',
            '中途不要停下来询问，每轮开头标注【第 k/N 轮】，全部轮次完成后统一汇报。',
            '（9）★ 交付门槛（硬性）：任何改动必须由你自己实测通过，才能告诉用户"可以用"。',
            'UI / 插件类改动必须重启后在真实界面里逐项确认：聊天框能打开、能输入文字、能发送、',
            '消息与回复能正常显示、权限菜单能打开并切换、页面不白屏、不卡在启动页；',
            '改完没重启过、没亲眼看过，就不算测过。测试不通过就继续修，不许说"应该没问题"，',
            '更不许把测试交给用户——用户只做最后验收。',
          ].join(''),
        })
        mark('systemPrompt', true)
      } catch (error) {
        mark('systemPrompt', false)
        console.warn('admin-mode: systemPrompt section skipped:', String(error))
      }
    })
  } catch (error) {
    mark('systemPrompt', false)
  }

  // ================================================================ 保底 2/3 —— 已停用
  // ★ 2026-10-21 主人明确要求：规则不要出现在对话框里。
  //   agent.inject() 的本质是往会话 inbox 插一条 user 消息，界面**必然**显示成一条
  //   对话，无法靠参数隐藏（以前那条「管理员模式核心规则」就是这么冒出来的）。
  //   所以彻底停用 inject 通道，规则只走上面「保底 1」的 systemPrompt.section：
  //   它只进模型系统提示，不进消息流，用户在对话框里看不到任何多余内容。

  // agent/created 只留一个加载标记，用于诊断文件确认插件真的被宿主加载。
  try {
    // ★ 事件参数是 { agent, source, signal }，不是 agent 本身
    ctx.on('agent/created', () => {
      mark('agentCreated', true)
    })
  } catch (error) {
    mark('agentCreated', false)
  }

  // ================================================================ 鼠标门控
  let permissionPresets = null
  try {
    ctx.inject(['permissionPresets'], (childCtx) => {
      try {
        permissionPresets = childCtx.permissionPresets
        mark('permissionPresets', true)
      } catch {
        mark('permissionPresets', false)
      }
      // ★ 2026-10-21 回滚：不再把「管理员」桥接成 auto。
      //   实测 auto + approval=never = 审查拒绝即静默拒绝，所有工具调用全被拦死
      //   （连只读命令都 100% 失败），管理员档直接变废档。
      //   现在「管理员」= 纯 danger-full-access + never（无沙箱、永不询问）；
      //   官方「自动审查（auto）」作为独立档原样放回权限菜单，由用户自行选择。
    })
  } catch {
    mark('permissionPresets', false)
  }

  // ★ 2026-10-23 修复：本包 `export const inject = []`，apply 期间 ctx.tools 不存在，
  //   直接 ctx.tools.guard 会抛错并被吞掉（诊断里 mouseGuardRegistered=fail）。
  //   改为在 tools 服务就绪后再注册。
  try {
    ctx.inject(['tools'], (toolsCtx) => {
      try {
        toolsCtx.tools.guard((exec) => {
          // ★ 2026-10-21 起用于确认「MCP 类工具（cua_driver_native__*）到底走不走 tools.guard」；
          //   2026-11-04 在 rc.5 真实宿主里实测：走，且生效。
          //   诊断里出现 `mouseGuardDeny=<工具名> @ <权限档>` 即为真拦截。
          //   注意：这里不能无条件写盘 —— guard 每次工具调用都会被问一次，
          //   无条件 note() 等于每个工具调用都同步写一遍文件。只在第一次 / cua 工具时记。
          guardCalls += 1
          const name = exec && exec.name
          guardLast = String(name)
          if (guardCalls === 1 || isCuaTool(name)) {
            note('mouseGuardCalls', guardCalls)
            note('mouseGuardLast', guardLast)
          }
          if (!isGatedTool(name)) return undefined
          if (!permissionPresets) return undefined
          let preset
          try {
            const session = exec.agent?.session
            preset = session ? permissionPresets.current(session) : undefined
          } catch {
            preset = undefined
          }
          // 只有「管理员」档（纯 danger-full-access + never）放行电脑操作；
          // 官方「自动审查（auto）」是独立档，不再等同管理员。
          if (preset === 'admin') {
            note('mouseGuardAllow', name + ' @ admin')
            return undefined
          }
          note('mouseGuardDeny', name + ' @ ' + (preset ?? '未知'))
          return (
            '电脑操作（鼠标/键盘/剪贴板/窗口/应用控制）仅限「管理员」权限档：' +
            `当前权限档是「${preset ?? '未知'}」，已拒绝执行 ${name}。` +
            '请切换到管理员档，或者用不涉及屏幕操作的方式完成任务。'
          )
        })
        mark('mouseGuardRegistered', true)
      } catch (error) {
        mark('mouseGuardRegistered', false)
        mark('mouseGuardErr', String(error && error.message || error).slice(0, 160))
        console.warn('admin-mode: mouse guard skipped:', String(error))
      }
    })
  } catch (error) {
    mark('mouseGuardRegistered', false)
    mark('mouseGuardErr', 'outer:' + String(error && error.message || error).slice(0, 150))
    console.warn('admin-mode: mouse guard unavailable:', String(error))
  }

  // ================================================================ 鼠标状态
  const MOUSE_ACTIVE_WINDOW_MS = 30000
  let lastMouseAt = 0

  ctx.on('tools/pre-execute', (exec, next) => {
    if (isGatedTool(exec.name)) lastMouseAt = Date.now()
    return next()
  })

  ctx.on('tools/result', (exec) => {
    if (isGatedTool(exec.name)) lastMouseAt = Date.now()
  })

  try {
    ctx.on('agent/inbox/claimed', () => {
      lastMouseAt = 0
    })
  } catch {
    // event may not exist in older runtimes
  }

  // ================================================================ 状态路由
  let sessionsService = null
  try {
    ctx.inject(['sessions'], (childCtx) => {
      sessionsService = childCtx.sessions
    })
  } catch {
    sessionsService = null
  }
  try {
    ctx.inject(['webServer'], (childCtx) => {
      try {
        childCtx.effect(
          () =>
            childCtx.webServer.register({
              kind: 'prefix',
              path: '/admin-mode',
              handler: async (req, res) => {
                const pathname = String(req.url || '').split('?')[0]
                if (pathname === '/admin-mode/selftest' && req.method === 'POST') {
                  // ★ UI 自检上报：客户端加载后探测「聊天框还在不在」，
                  //   结果落进诊断文件（%TEMP%\dsh_admin_mode_diag.<profile>.<pid>.txt，
                  //   并镜像一份到 %TEMP%\dsh_admin_mode_diag.txt.latest），
                  //   便于交付前确认没有把 composer 搞崩。
                  try {
                    const chunks = []
                    for await (const chunk of req) chunks.push(chunk)
                    const raw = Buffer.concat(chunks).toString('utf8').slice(0, 4000)
                    const parsed = raw.length > 0 ? JSON.parse(raw) : {}
                    mark('uiSelfTest', parsed && parsed.composer === true)
                    mark('uiSelfTestDetail', raw.replace(/\s+/g, ' ').slice(0, 300))
                    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
                    res.end(JSON.stringify({ ok: true }))
                  } catch (error) {
                    res.writeHead(400, { 'content-type': 'text/plain' })
                    res.end('bad selftest payload')
                  }
                  return
                }
                if (pathname !== '/admin-mode/hud') {
                  res.writeHead(404, { 'content-type': 'text/plain' })
                  res.end('not found')
                  return
                }
                const active = Date.now() - lastMouseAt < MOUSE_ACTIVE_WINDOW_MS
                res.writeHead(200, {
                  'content-type': 'application/json',
                  'cache-control': 'no-store',
                })
                res.end(JSON.stringify({ active }))
              },
            }),
          'admin-mode: hud state route',
        )
        mark('webServer', true)
      } catch (error) {
        mark('webServer', false)
        console.warn('admin-mode: hud route skipped:', String(error))
      }
    })
  } catch {
    mark('webServer', false)
  }
}
