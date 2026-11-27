import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 用真实 Chrome（无头）截 lib/client.js 的真实渲染。
 *
 * 不手画 mockup、不靠 DOM 断言交差：页面里跑的就是插件自己的客户端 bundle，
 * 数据来自 tools/preview/server.mjs 里那份真状态机。
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const outDir = join(root, 'docs')
const port = Number(process.env.PREVIEW_PORT ?? 3491)
const guestPort = Number(process.env.PREVIEW_GUEST_PORT ?? port + 1)
const emptyPort = Number(process.env.PREVIEW_EMPTY_PORT ?? port + 10)

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
].find((path) => path && existsSync(path))

if (!CHROME) throw new Error('找不到 Chrome 可执行文件')

// 一张截图可以带多条断言：面板那张既要验「看了就算已读」，也要验「agent 的职责能改」。
const wants = (shot, name) => (Array.isArray(shot.verify) ? shot.verify.includes(name) : shot.verify === name)

/**
 * 直接问某一侧宿主「此刻屋里是什么样」。
 *
 * 用在加入方那一屏：镜像有没有跟上宿主，只能问出来，不能等时间等出来。
 * 信封和界面走的是同一条 `/api/dsh.chatroom/snapshot`。
 */
async function snapshotOf(target) {
  const res = await fetch(`http://127.0.0.1:${target}/api/dsh.chatroom/snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'settle', method: 'dsh.chatroom/snapshot', payload: {} }),
  })
  const body = await res.json()
  if (!body.result?.ok) throw new Error(`问 ${target} 要快照失败：${JSON.stringify(body.result)}`)
  return body.result.value
}

const shots = [
  {
    name: 'empty',
    // 这一屏要的是一台「刚装好、一间屋子都还没有」的服务：主服务里房间早就种好了，
    // 拿它截不出空状态。脚本自己按需起一台，截完就关（见 startEmptyServer）。
    server: 'empty',
    view: 'panel',
    waitFor: '.cr-first',
    verify: 'first-run',
    caption: '刚装好、还没有房间时的第一屏：房间在自己机器上、另一台机器怎么进来，两个入口当场可用 —— 不是一块空白',
  },
  {
    name: 'panel',
    view: 'panel',
    waitFor: '.cr-msg',
    verify: ['panel-read', 'agent-edit', 'confirm-delete'],
    caption: '房间面板：房间列表 / 群聊 / 成员与规则入口；从 LAN 加入的人和他的 agent 带远程 chip',
  },
  {
    name: 'agent-edit',
    view: 'panel',
    waitFor: '.cr-msg',
    settle: 'read',
    open: '改',
    caption: 'agent 的名字、职责与它在这间屋里的虎鲸颜色随时可改；颜色是这一间屋的座位',
  },
  {
    name: 'new-room',
    view: 'panel',
    waitFor: '.cr-msg',
    settle: 'read',
    open: '+ 新建房间',
    verify: 'new-room',
    caption: '新建房间先挑一档虎鲸颜色：没挑之前「创建」是灰的 —— 每间屋的座位要自己选',
  },
  {
    name: 'invite',
    view: 'panel',
    waitFor: '.cr-msg',
    open: '邀请',
    verify: ['invite-address', 'name-edit'],
    caption: '邀请另一台机器：局域网地址 + 房间码就是全部凭据；装 WSL/Hyper-V 的机器把真实网卡排前面，其余的列在下面并标出虚拟网卡',
  },
  {
    name: 'join-error',
    view: 'panel',
    waitFor: '.cr-msg',
    // 未读徽标是「面板可见时自动清零」的：清掉那一下和拍照之间会差一帧，
    // 同一份代码两次就能拍出带徽标和不带徽标两张 —— 等它结算完再拍。
    settle: 'read',
    before: 'join-fail',
    verify: 'join-error',
    caption: '加入失败时：直说连不上哪台、填过的地址和房间码留着能改；失败的加入不会在列表里留下半间屋子',
  },
  {
    name: 'rules',
    view: 'rules',
    waitFor: '.cr-msg',
    settle: 'read',
    open: '规则',
    caption: '三条发言规则并行开关：被 @ 必回、全员轮次、主持人指派，共用发言预算',
  },
  {
    name: 'guest',
    port: guestPort,
    view: 'panel',
    waitFor: '.cr-msg',
    settle: 'mirror',
    caption: '同一间屋子，加入那台机器看到的视角：自己的人是本机，宿主的成员标 LAN · 由 <机器名> 主持',
  },
  {
    name: 'float',
    view: 'session',
    waitFor: '.cr-float-pill',
    open: '.cr-float-pill',
    verify: 'float-bounds',
    caption: '会话界面里的独立悬浮窗：标题栏开关、拖动、折叠都在这一个入口',
  },
  {
    name: 'notify',
    view: 'session',
    waitFor: '.cr-float-pill',
    nudge: true,
    waitForAfter: '.cr-toast',
    verify: 'read',
    caption: '新消息提醒：折叠胶囊上的未读数 + 右上角 toast，标题栏前缀同步',
  },
  {
    name: 'three-machines',
    view: 'panel',
    setup: '/preview/third',
    waitFor: '.cr-msg',
    settle: 'read',
    verify: 'three-parties',
    caption: '三台机器同屋：本机 + 两台 LAN 机器各带自己的 agent，成员与消息都按机器名区分',
  },
  {
    name: 'bring-agent',
    view: 'panel',
    setup: '/preview/bring',
    waitFor: '.cr-msg',
    settle: 'read',
    verify: 'bring-agent',
    caption: '加入之后才建的 agent：那台机器把名单报上来，宿主这边立刻多一个人，@ 它还能跨机跑一轮',
  },
  {
    name: 'old-peer',
    view: 'panel',
    setup: '/preview/old-peer',
    waitFor: '.cr-peer',
    settle: 'read',
    verify: 'old-peer',
    caption: '版本不一致：进来的那台是旧版本，界面直说「报不了 agent 名单、重启那台的桌面端」，而不是让人猜',
  },
  {
    name: 'retry',
    view: 'panel',
    setup: '/preview/fail',
    waitFor: '.cr-msg-actions',
    settle: 'read',
    verify: 'retry',
    caption: 'agent 没回上来时：占位消息留在房里，底下一个「重试」只重跑它一个，不惊动别人',
  },
  {
    name: 'approve',
    // 演完当场点「允许一次」把这一轮放过去（下一屏 gone 就在这间屋子拍），
    // 所以它不能排在最后：最后一屏要留给会真发一句的 ime-enter。
    view: 'panel',
    setup: '/preview/approval',
    waitFor: '.cr-approve',
    settle: 'read',
    verify: 'approve',
    caption: '别的机器要在这台机器上跑一个 agent 回合：先说清是谁、哪台机器、要它做什么，点了才跑；默认那一档是只读',
  },
  {
    name: 'gone',
    port: guestPort,
    view: 'panel',
    setup: '/preview/dissolve',
    waitFor: 'textarea[disabled]',
    settle: 'read',
    caption: '宿主解散后加入方看到的样子：历史还在、输入锁住、右栏写下原因并只留「从列表移除」',
  },
  {
    name: 'no-reply',
    view: 'panel',
    setup: '/preview/no-reply',
    waitFor: '.cr-hint',
    settle: 'read',
    verify: 'no-reply',
    caption: '说了一句、谁都没接的时候：界面直接说是「没叫到人」，而不是让人对着一片安静以为插件坏了',
  },
  {
    name: 'history',
    view: 'panel',
    setup: '/preview/history',
    waitFor: '.cr-older-btn',
    settle: 'read',
    before: 'history-top',
    verify: 'history',
    caption: '说满 200 句之后：更早的话还能一句一句翻回来，而不是只剩一句「只显示最近 200 条」',
  },
  {
    name: 'history-live',
    view: 'panel',
    setup: '/preview/history-live',
    waitFor: '.cr-older-btn',
    before: 'history-live-top',
    verify: ['history-live', 'ime-enter', 'draft-per-room', 'mention'],
    caption: '翻着历史时屋里又进来话：出口上写清「几条新的」，人没被拽到底部，投影滑动留下的那道接缝也补上了',
  },
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForJson(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
    } catch {
      /* Chrome 还没起来 */
    }
    await sleep(250)
  }
  throw new Error(`CDP 没有就绪：${url}`)
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.next = 1
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
      else entry.resolve(message.result)
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
    })
    return new Cdp(ws)
  }

  send(method, params = {}, sessionId) {
    const id = this.next++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.ws.send(JSON.stringify(payload))
    })
  }

  close() {
    this.ws.close()
  }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  )
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? '页面脚本报错')
  return result.result?.value
}

async function waitForSelector(cdp, sessionId, selector, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    const count = await evaluate(cdp, sessionId, `document.querySelectorAll(${JSON.stringify(selector)}).length`)
    if (count > 0) return count
    await sleep(100)
  }
  // 找不到的时候得说清「页面当时长什么样」：空白页、报错条、还是只是房间没选中。
  const state = await evaluate(
    cdp,
    sessionId,
    `(() => ({
      rooms: [...document.querySelectorAll('.cr-room-name')].map((node) => String(node.textContent).trim()),
      active: (document.querySelector('.cr-room.cr-active .cr-room-name') || {}).textContent || null,
      errors: [...document.querySelectorAll('.cr-error-bar')].map((node) => String(node.textContent).trim()),
      body: document.body ? document.body.innerText.slice(0, 160) : null,
    }))()`,
  ).catch((error) => ({ readFailed: String(error && error.message) }))
  throw new Error(`等不到元素：${selector}｜页面当时：${JSON.stringify(state)}`)
}

// 名字 / 虎鲸 / 我的 agent 都收进了「设置」弹窗：断言这些控件之前先开窗，跑完关掉，
// 否则后面的截图会带着一层遮罩。
async function openSettings(cdp, sessionId) {
  const opened = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const button = [...document.querySelectorAll('.cr-col-foot .cr-link-btn')].find(
        (node) => node.textContent.trim() === '设置',
      )
      if (!button) return false
      button.click()
      return true
    })()`,
  )
  if (!opened) throw new Error('左栏底部点不开「设置」')
  await waitForSelector(cdp, sessionId, '.cr-settings')
}

async function closeSettings(cdp, sessionId) {
  const closed = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const button = document.querySelector('.cr-settings-head .cr-icon-btn')
      if (!button) return false
      button.click()
      return true
    })()`,
  )
  if (!closed) throw new Error('设置弹窗上没有关闭按钮')
  for (let i = 0; i < 40; i += 1) {
    if (await evaluate(cdp, sessionId, `!document.querySelector('.cr-settings')`)) return
    await sleep(80)
  }
  throw new Error('设置弹窗没有关掉，后面的截图会带着遮罩')
}

/** 元素在视口里的位置，连视口大小一起取回来，好判断它是不是跑出去了。 */
async function boundsOf(cdp, sessionId, selector) {
  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)})
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return {
        left: Math.round(rect.left), top: Math.round(rect.top),
        right: Math.round(rect.right), bottom: Math.round(rect.bottom),
        width: Math.round(rect.width), height: Math.round(rect.height),
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }
    })()`,
  )
}

/**
 * 真的让插件去连一个连不上的地址：「刚占过又放掉」的那个端口号，确定没人监听。
 * 走的是宿主那台真实的 `lan.join`，所以界面上那句报错是真的，不是摆拍出来的。
 *
 * 端口要可复现：取一个固定的候选号（这一屏的文案里就带着这个号，随机会让每次
 * 重跑都得到一张像素不同的图，「只改了别处」也会显得 join-error 全红）。
 * 候选号都被占了才退回系统挑的空闲端口。
 */
const CANDIDATE_PORTS = [4599, 4598, 4597, 4596]
let joinFailRooms = 0
let joinFailTarget = ''

async function closedPort() {
  for (const port of CANDIDATE_PORTS) {
    const probe = createServer()
    const free = await new Promise((resolve) => {
      probe.once('error', () => resolve(false))
      probe.listen(port, '127.0.0.1', () => resolve(true))
    })
    await new Promise((resolve) => probe.close(resolve))
    if (free) return port
  }
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/**
 * 从页面里直接走命令通道发几句话进当前屋子。
 *
 * 用的是界面自己那条 `/api/dsh.chatroom/<端点>`（信封、Cookie 都一样），所以宿主真落库、
 * 长轮询真把新投影推回页面 —— 用来把「人翻着历史时屋里又进来话」这个中间态做出来，
 * 而不是往界面里塞假数据。
 */
async function sayInRoom(cdp, sessionId, texts) {
  const answer = await evaluate(
    cdp,
    sessionId,
    `(async () => {
      const call = (method, payload, rpcId) =>
        fetch('/api/dsh.chatroom/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ type: 'client-request', rpcId: rpcId, method: 'dsh.chatroom/' + method, payload: payload }),
        }).then((res) => res.json())
      const snapshot = await call('snapshot', {}, 'say-snapshot')
      const roomId = snapshot.result.value.activeRoomId
      const lines = ${JSON.stringify(texts)}
      const sent = []
      for (let i = 0; i < lines.length; i += 1) {
        const result = await call('command', { action: 'msg.send', input: { roomId: roomId, text: lines[i], mentions: [], opKey: 'say_' + i } }, 'say-' + i)
        sent.push(result.result && result.result.ok ? 'ok' : JSON.stringify(result.result && result.result.error))
      }
      return { roomId: roomId, sent: sent }
    })()`,
  )
  if (!answer || !answer.roomId) throw new Error('那几句没发进去')
  const failed = answer.sent.find((row) => row !== 'ok')
  if (failed) throw new Error(`发消息被宿主打回来了：${failed}`)
  return answer
}

async function attemptFailingJoin(cdp, sessionId) {
  joinFailTarget = `127.0.0.1:${await closedPort()}`
  joinFailRooms = await evaluate(cdp, sessionId, `document.querySelectorAll('.cr-room').length`)
  const opened = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const button = [...document.querySelectorAll('.cr-link-btn')].find((node) =>
        node.textContent.includes('加入 LAN 房间'),
      )
      if (!button) return false
      button.click()
      return true
    })()`,
  )
  if (!opened) throw new Error('点不开「+ 加入 LAN 房间」')
  await sleep(200)
  const filled = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const inputs = [...document.querySelectorAll('input.cr-field')]
      const address = inputs.find((node) => String(node.placeholder || '').includes('对方地址'))
      const code = inputs.find((node) => String(node.placeholder || '').includes('房间码'))
      if (!address || !code) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      const put = (el, value) => {
        el.focus()
        setter.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      put(address, ${JSON.stringify(joinFailTarget)})
      put(code, 'ZZZZZZ')
      return true
    })()`,
  )
  if (!filled) throw new Error('填不进加入表单')
  // 进屋要自己挑一档颜色：不挑的时候「加入」是灰的（这一步本身也是那条规则的证据）。
  const colored = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const form = document.querySelector('.cr-join-form')
      const dot = form && form.querySelector('.cr-sw-dot')
      if (!dot) return false
      dot.click()
      return true
    })()`,
  )
  if (!colored) throw new Error('加入表单里挑不到虎鲸颜色')
  await sleep(120)
  const submitted = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const button = [...document.querySelectorAll('button.cr-primary')].find(
        (node) => node.textContent.trim() === '加入',
      )
      if (!button || button.disabled) return false
      button.click()
      return true
    })()`,
  )
  if (!submitted) throw new Error('「加入」点不动（要么没找到，要么还是禁用的）')
  for (let i = 0; i < 80; i += 1) {
    if (await evaluate(cdp, sessionId, `Boolean(document.querySelector('.cr-error-bar'))`)) return
    await sleep(100)
  }
  throw new Error('加入失败了，界面却没有报错')
}

function assertInside(box, message) {
  if (!box) throw new Error(`${message}：找不到元素`)
  const outside =
    box.left < 0 || box.top < 0 || box.right > box.viewport.width || box.bottom > box.viewport.height
  if (outside) throw new Error(`${message}：${JSON.stringify(box)}`)
}

// 预览服务器里那份状态机是活的：上一轮截图会往里补消息、把屋子解散。
// 拿同一份用过的状态再截一遍，图和断言都会偏，而且看起来还挺像那么回事 —— 所以先确认它是刚起来的。
async function assertFreshServer() {
  let info
  try {
    const response = await fetch(`http://127.0.0.1:${port}/preview/writes`)
    if (!response.ok) throw Object.assign(new Error('stale server'), { stale: true })
    info = await response.json()
  } catch (error) {
    if (error?.stale) throw new Error(`预览服务器是旧版本（没有 /preview/writes）：重启 npm run preview:serve`)
    throw new Error(`预览服务器没起来：先跑 npm run preview:serve（期望端口 ${port}）`)
  }
  if (Number(info.writes) > 0) {
    throw new Error(
      `预览服务器的状态已经被写过 ${info.writes} 次：重启 npm run preview:serve 再截，图才和 docs/ 对得上`,
    )
  }
  return info
}

const fresh = await assertFreshServer()
console.log(`preview server fresh — room code ${fresh.roomCode}, LAN port ${fresh.lanPort}`)

/**
 * 起一台只演「一间屋子都还没有」的预览服务。
 *
 * 复用同一个 server.mjs（真状态机、真快照），只是不种房间、不拉第二台机器加入；
 * 端口另开，退出时杀掉 —— 不会碰你自己已经跑起来的那台。
 */
async function startEmptyServer() {
  const proc = spawn(process.execPath, [join(here, 'server.mjs')], {
    env: {
      ...process.env,
      PREVIEW_EMPTY: '1',
      PREVIEW_PORT: String(emptyPort),
      PREVIEW_GUEST_PORT: String(emptyPort + 1),
      // 空状态那张图里没有任何局域网内容，端口交给系统挑，免得和正在跑的那台撞上。
      PREVIEW_LAN_PORT: '0',
    },
    stdio: 'ignore',
  })
  let lastError = null
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${emptyPort}/preview/writes`)
      if (response.ok) {
        const info = await response.json()
        if (info.empty !== true) throw Object.assign(new Error('这台预览服务不是空状态模式'), { fatal: true })
        if (Number(info.writes) > 0) {
          throw Object.assign(new Error(`空状态预览服务已经被写过 ${info.writes} 次`), { fatal: true })
        }
        return proc
      }
    } catch (error) {
      if (error?.fatal) {
        proc.kill()
        throw error
      }
      lastError = error
    }
    await sleep(250)
  }
  proc.kill()
  throw new Error(`空状态预览服务没起来：端口 ${emptyPort}（${String(lastError?.message ?? '')}）`)
}

/**
 * Chrome 自己挑的 CDP 端口。
 *
 * 写死端口（原来是 9333）有过一次很费解的翻车：上一次跑没死透的无头 Chrome 还占着它，
 * 新起的那只绑不上就直接退出，脚本于是连到了那个**旧**浏览器 —— 它已经连不上本机服务，
 * 于是每一屏都是空白页、导航报 ERR_CONNECTION_REFUSED，而 curl 明明是通的。
 * 让 Chrome 用 0 自己挑，端口它会写进 <profile>/DevToolsActivePort 第一行，从此互不干扰。
 */
async function cdpPortOf(dir) {
  for (let i = 0; i < 200; i += 1) {
    try {
      const text = await readFile(join(dir, 'DevToolsActivePort'), 'utf8')
      const port = Number(text.split('\n')[0])
      if (port > 0) return port
    } catch {
      /* Chrome 还没把端口写出来 */
    }
    await sleep(100)
  }
  throw new Error('Chrome 没写出 DevToolsActivePort：无头浏览器没起来')
}

const profileDir = await mkdtemp(join(tmpdir(), 'chatroom-shot-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--force-device-scale-factor=2',
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

// 空状态那一屏自己起的那台服务；截完在 finally 里关掉。
let emptyProc = null

try {
  const cdpPort = await cdpPortOf(profileDir)
  const version = await waitForJson(`http://127.0.0.1:${cdpPort}/json/version`)
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl)
  await mkdir(outDir, { recursive: true })

  // 调某一屏时可以只跑它：--only=history（多屏用逗号）。整轮验收还是不带参数全跑。
  const only = process.argv
    .filter((row) => row.startsWith('--only='))
    .flatMap((row) => row.slice('--only='.length).split(','))
    .map((row) => row.trim())
    .filter(Boolean)
  const targets = only.length ? shots.filter((shot) => only.includes(shot.name)) : shots
  for (const shot of targets) {
    // 有的状态得先把屋子演进到那一步（例如宿主解散）再截，不能靠假数据摆拍。
    // 这类准备动作作用在宿主那份状态机上，所以固定走宿主端口。
    if (shot.setup) await fetch(`http://127.0.0.1:${port}${shot.setup}`)
    let shotPort = shot.port ?? port
    if (shot.server === 'empty') {
      if (!emptyProc) emptyProc = await startEmptyServer()
      shotPort = emptyPort
    }
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    }, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    // 导航失败要当场说清楚：不然等着等去只等到一个空白页。
    const nav = await cdp.send('Page.navigate', { url: `http://127.0.0.1:${shotPort}/?view=${shot.view}` }, sessionId)
    if (nav && nav.errorText) throw new Error(`打不开这一屏（${shot.name}，端口 ${shotPort}）：${nav.errorText}`)
    await waitForSelector(cdp, sessionId, shot.waitFor)
    if (shot.nudge) {
      await fetch(`http://127.0.0.1:${shotPort}/preview/nudge`)
      await waitForSelector(cdp, sessionId, shot.waitForAfter)
    }
    if (shot.open) {
      const opened = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const target = ${JSON.stringify(shot.open)}
          const bySelector = target.startsWith('.') ? document.querySelector(target) : null
          const byText = !bySelector && [...document.querySelectorAll('button, [role="button"]')]
            .find((node) => node.textContent.trim() === target)
          const node = bySelector || byText
          if (!node) return false
          node.click()
          return true
        })()`,
      )
      if (!opened) throw new Error(`点不到：${shot.open}`)
      await sleep(350)
    }
    // 有的状态是「用户操作之后才出现」的（例如加入失败），得在拍照之前把它做出来，
    // 否则截图拍的是操作前那张，断言却在操作后跑 —— 图和结论对不上。
    if (shot.before === 'join-fail') await attemptFailingJoin(cdp, sessionId)
    // 翻页入口在列表顶端：先把消息区滚到最上面，截到的才是「列表的起点」。
    if (shot.before === 'history-top') {
      const atTop = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const flow = document.querySelector('.cr-flow')
          if (!flow) return false
          flow.scrollTop = 0
          // 滚到顶上之后，「回到最新」才会出现（scroll 事件异步派发，这里补一次，
          // 免得拍出来的图里没这个出口、断言却在断言它）。
          flow.dispatchEvent(new Event('scroll'))
          return true
        })()`,
      )
      if (!atTop) throw new Error('找不到消息区，滚不到顶部')
      await sleep(200)
    }
    // 「翻着历史时来了新消息」那一屏：先翻出一整段历史、滚到顶上（人停在上面读），
    // 再让屋里真的进来两句 —— 拍的是「新消息已经进来、人还没动」的那一刻，不是操作前的样子。
    if (shot.before === 'history-live-top') {
      await evaluate(cdp, sessionId, `document.querySelector('.cr-older-btn').click()`)
      let paged = 0
      for (let i = 0; i < 80; i += 1) {
        paged = await evaluate(cdp, sessionId, `document.querySelectorAll('.cr-msg').length`)
        if (paged >= 240) break
        await sleep(100)
      }
      if (paged < 240) throw new Error(`翻不出一整段历史：${paged} 条`)
      await evaluate(
        cdp,
        sessionId,
        `(() => {
          const flow = document.querySelector('.cr-flow')
          if (!flow) return false
          flow.scrollTop = 0
          flow.dispatchEvent(new Event('scroll'))
          return true
        })()`,
      )
      await sleep(200)
      await sayInRoom(cdp, sessionId, ['这两句是翻着历史时进来的', '第二句也一样'])
      // 这两句是界面里真发出去的，at 是**真实时钟**：房间列表右上角那句 HH:MM 于是每次都不同 ——
      // 同一份代码重跑两次会得到两张不同的 PNG。把时间重新钉回固定档，等界面真的换成它再拍。
      const pinned = await (await fetch(`http://127.0.0.1:${port}/preview/pin`)).json()
      const activeTitle = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const node = document.querySelector('.cr-room.cr-active .cr-room-name')
          return node ? String(node.textContent).trim() : null
        })()`,
      )
      const wantClock = (pinned.rooms ?? []).find((room) => room.name === activeTitle)?.clock ?? null
      if (!wantClock) throw new Error(`钉完时间对不上当前屋子：${JSON.stringify({ activeTitle, rooms: pinned.rooms })}`)
      let shownClock = null
      for (let i = 0; i < 60; i += 1) {
        shownClock = await evaluate(
          cdp,
          sessionId,
          `(() => {
            const node = document.querySelector('.cr-room.cr-active .cr-room-time')
            return node ? String(node.textContent).trim() : null
          })()`,
        )
        if (shownClock === wantClock) break
        await sleep(100)
      }
      if (shownClock !== wantClock) {
        throw new Error(`房间列表那格时间没换成钉住的值：应该是 ${wantClock}，实际是 ${JSON.stringify(shownClock)}`)
      }
      let label = null
      for (let i = 0; i < 80; i += 1) {
        label = await evaluate(
          cdp,
          sessionId,
          `(() => {
            const node = document.querySelector('.cr-jump')
            return {
              text: node ? String(node.textContent).trim() : null,
              rows: document.querySelectorAll('.cr-msg').length,
            }
          })()`,
        )
        if (label && label.rows === 242 && /条新的/.test(label.text || '')) break
        await sleep(100)
      }
      if (!label || label.rows !== 242 || !/2 条新的/.test(label.text || '')) {
        throw new Error(`拍之前那个状态没做出来：${JSON.stringify(label)}`)
      }
      await sleep(250)
    }
    // 截图要截「稳定下来的界面」，不是「刚好路过的中间态」：三台机器那张图里，
    // 远程 agent 的回复会在页面加载之后才落库，未读徽标会在面板可见的情况下
    // 自动清零 —— 等它清完再拍，否则同一份代码两次会拍出带徽标和不带徽标两张。
    //
    // 'mirror' 是加入方那一屏：除了未读要清掉，还得先等它真的把宿主那边跟上来。
    // 前面几屏验证「面板可见时新消息直接算已读」时会往屋里放一条消息，加入方的
    // 镜像要不要跟着长，取决于那次长轮询有没有在这几毫秒里回来 —— 只等时间就会
    // 时好时坏（这一屏曾经因为差了这一条，同一份代码拍出两张不同的图）。
    if (shot.settle === 'mirror') {
      const shared = (view) => view.rooms.find((room) => room.remote) ?? view.rooms[0]
      const mirror = shared(await snapshotOf(shotPort))
      // 同一间屋子按房间码认：宿主这边不止一间，拿错房间比的就是两件不相干的事。
      const hostView = await snapshotOf(port)
      const hostRoom = (mirror && hostView.rooms.find((room) => room.code === mirror.code)) ?? hostView.rooms[0]
      let synced = false
      for (let i = 0; i < 60; i += 1) {
        const now = shared(await snapshotOf(shotPort))
        if (now && hostRoom && now.nextSeq >= hostRoom.nextSeq) {
          synced = true
          break
        }
        await sleep(100)
      }
      if (!synced) throw new Error('加入方那边的镜像没有跟上宿主：这时候拍下来的不是「同一间屋子」')
    }
    if (shot.settle === 'read' || shot.settle === 'mirror') {
      for (let i = 0; i < 40; i += 1) {
        const left = await evaluate(
          cdp,
          sessionId,
          `document.querySelectorAll('.cr-badge, .cr-nav-badge').length`,
        )
        if (left === 0) break
        await sleep(100)
      }
    }
    await sleep(250)
    // 输入框里那条光标会闪：它落在哪一相位取决于按快门的瞬间。和动画一样，
    // 截图里不该有这种活的东西 —— 把 caret 变透明（焦点态本身保留）。
    await evaluate(
      cdp,
      sessionId,
      `(() => {
        let style = document.getElementById('cr-shot-caret')
        if (!style) {
          style = document.createElement('style')
          style.id = 'cr-shot-caret'
          style.textContent = 'input,textarea,[contenteditable]{caret-color:transparent!important}'
          document.head.appendChild(style)
        }
        return true
      })()`,
    )
    // 授权那屏右下角是个活的倒计时：同一份代码隔几秒重跑就会差一个数字，
    // docs/ 里那张图于是永远对不上。停掉计时、把初始值（宿主给的 90 秒）钉回去再拍。
    // 「等待授权」那行的三个点是 CSS 无限动画，同样会把两次截图错开半帧 —— 一并冻住。
    if (shot.name === 'approve') {
      await evaluate(
        cdp,
        sessionId,
        `(() => {
          for (let id = 1; id < 1000; id += 1) clearInterval(id)
          const nodes = document.querySelectorAll('.cr-approve-count')
          if (nodes.length) nodes[nodes.length - 1].textContent = '90s'
          document.querySelectorAll('.cr-dot').forEach((node) => {
            node.style.animation = 'none'
            node.style.opacity = '0.5'
          })
          return true
        })()`,
      )
      await sleep(80)
    }
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
    const file = join(outDir, `${shot.name}.png`)
    await writeFile(file, Buffer.from(data, 'base64'))
    console.log(`saved ${file} — ${shot.caption}`)

    // 首屏：一间屋子都还没有的时候，这是新装的人看到的第一屏。
    // 只留一句提示会让中栏、右栏各空一大块，看起来像界面挂了 —— 所以这里既量版面，
    // 也真去点那两个入口：它们必须真的把表单开出来，而不是长在图上好看的按钮。
    if (wants(shot, 'first-run')) {
      const state = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const text = (node) => (node ? String(node.textContent).trim() : '')
          const box = (node) => {
            if (!node) return null
            const rect = node.getBoundingClientRect()
            return {
              left: Math.round(rect.left),
              top: Math.round(rect.top),
              right: Math.round(rect.right),
              bottom: Math.round(rect.bottom),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            }
          }
          const grid = document.querySelector('.cr-grid')
          const columns = [...document.querySelectorAll('.cr-grid > .cr-col')]
          return {
            rooms: document.querySelectorAll('.cr-room').length,
            columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
            title: text(document.querySelector('.cr-first-title')),
            body: text(document.querySelector('.cr-first-text')),
            note: text(document.querySelector('.cr-first-note')),
            buttons: [...document.querySelectorAll('.cr-first button')].map((node) => ({
              label: text(node),
              box: box(node),
            })),
            inner: box(document.querySelector('.cr-first-inner')),
            list: box(columns[0] || null),
            viewport: { width: window.innerWidth, height: window.innerHeight },
            overflowX: document.documentElement.scrollWidth - window.innerWidth,
          }
        })()`,
      )
      if (state.rooms !== 0) throw new Error(`这一屏该是「一间屋子都没有」，实际有 ${state.rooms} 间`)
      if (state.columns !== 2) {
        throw new Error(`没有房间时不该留第三列（成员列）撑着：实际 ${state.columns} 列`)
      }
      const labels = state.buttons.map((row) => row.label)
      if (labels.join('|') !== '新建房间|加入 LAN 房间') {
        throw new Error(`首屏的两个入口不对：${JSON.stringify(labels)}`)
      }
      for (const key of ['title', 'body', 'note']) {
        if (!state[key]) throw new Error(`首屏少了 ${key}：${JSON.stringify(state[key])}`)
      }
      if (!/六位房间码/.test(state.body)) throw new Error(`首屏没说清另一台机器怎么进来：${state.body}`)
      if (!/agent/.test(state.body)) throw new Error(`首屏没说清这屋子是给 agent 说话用的：${state.body}`)
      if (!/规则/.test(state.note)) throw new Error(`首屏没交代发言预算在哪定：${state.note}`)
      if (/undefined|null|NaN/.test(state.title + state.body + state.note)) {
        throw new Error('首屏文案里有没填上的占位')
      }
      // 版面：说明块不越过左栏、不超出视口、按钮够大够点。
      if (!state.inner) throw new Error('首屏的说明块没渲染出来')
      if (state.inner.width > 460) throw new Error(`首屏说明块太宽：${state.inner.width}px`)
      if (state.list && state.inner.left < state.list.right - 2) {
        throw new Error(`首屏说明块压到左栏上了：说明块 ${state.inner.left} / 左栏右边界 ${state.list.right}`)
      }
      if (state.inner.top < 0 || state.inner.bottom > state.viewport.height) {
        throw new Error(`首屏说明块超出视口：${JSON.stringify(state.inner)}`)
      }
      if (state.overflowX > 0) throw new Error(`这一屏横向溢出了 ${state.overflowX}px`)
      for (const row of state.buttons) {
        if (!row.box || row.box.height < 24) {
          throw new Error(`入口「${row.label}」太矮，点不动：${JSON.stringify(row.box)}`)
        }
        if (row.box.width < 64) throw new Error(`入口「${row.label}」太窄：${row.box.width}px`)
        if (row.box.right > state.viewport.width || row.box.bottom > state.viewport.height) {
          throw new Error(`入口「${row.label}」跑到视口外：${JSON.stringify(row.box)}`)
        }
      }

      const clickIn = async (scope, label) => {
        const clicked = await evaluate(
          cdp,
          sessionId,
          `(() => {
            const root = document.querySelector(${JSON.stringify(scope)})
            if (!root) return false
            const node = [...root.querySelectorAll('button')].find((el) => el.textContent.trim() === ${JSON.stringify(label)})
            if (!node) return false
            node.click()
            return true
          })()`,
        )
        if (!clicked) throw new Error(`${scope} 里点不到「${label}」`)
        await sleep(250)
      }

      // 入口 1：新建房间 —— 真的把左栏的新建表单开出来。
      await clickIn('.cr-first', '新建房间')
      const creating = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const form = document.querySelector('.cr-form')
          if (!form) return { form: false }
          const inputs = [...form.querySelectorAll('input.cr-field')]
          const labels = [...form.querySelectorAll('button')].map((node) => String(node.textContent).trim())
          return {
            form: true,
            inputs: inputs.length,
            placeholders: inputs.map((el) => el.getAttribute('placeholder') || ''),
            labels,
          }
        })()`,
      )
      if (!creating.form || creating.inputs !== 2) {
        throw new Error(`首屏点「新建房间」没把表单开出来：${JSON.stringify(creating)}`)
      }
      if (!creating.labels.includes('建好')) throw new Error(`新建表单里没有「建好」：${JSON.stringify(creating.labels)}`)
      await clickIn('.cr-form', '取消')

      // 入口 2：加入 LAN 房间 —— 真的是地址 + 六位房间码那张表单，不是另一张。
      await clickIn('.cr-first', '加入 LAN 房间')
      const joining = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const inputs = [...document.querySelectorAll('input.cr-field')]
          const join = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '加入')
          return {
            inputs: inputs.length,
            placeholders: inputs.map((el) => el.getAttribute('placeholder') || ''),
            join: Boolean(join),
          }
        })()`,
      )
      if (!joining.inputs || !joining.join) throw new Error(`首屏点「加入 LAN 房间」没把加入表单开出来：${JSON.stringify(joining)}`)
      if (!joining.placeholders.some((row) => /地址/.test(row))) throw new Error(`加入表单缺地址一栏：${JSON.stringify(joining.placeholders)}`)
      if (!joining.placeholders.some((row) => /房间码/.test(row))) throw new Error(`加入表单缺房间码一栏：${JSON.stringify(joining.placeholders)}`)
      await clickIn('.cr-col', '取消')
      const back = await evaluate(cdp, sessionId, `Boolean(document.querySelector('.cr-first'))`)
      if (!back) throw new Error('两张表单取消之后首屏自己没了')
      console.log(`verified — 首屏：2 列（不留空成员列）、${state.title}；两个入口都真的开出表单（新建 / 地址+房间码）`)
    }

    // 反面：面板就摆在眼前时，新消息应该直接算已读（用户已经看到了）。
    // 和上面那条一起，才说明「该提醒时提醒、看过了就消」两半都在。
    if (wants(shot, 'panel-read')) {
      await fetch(`http://127.0.0.1:${shotPort}/preview/nudge`)
      let cleared = false
      for (let i = 0; i < 40; i += 1) {
        const state = await evaluate(
          cdp,
          sessionId,
          `({ badges: document.querySelectorAll('.cr-badge, .cr-nav-badge').length, title: document.title })`,
        )
        if (state.badges === 0 && !String(state.title).startsWith('(')) {
          cleared = true
          break
        }
        await sleep(100)
      }
      if (!cleared) throw new Error('面板可见时新消息没有自动算已读')
      console.log('verified — 面板可见时新消息直接算已读（未读不会涨）')
    }

    // 删掉一个 agent、解散一间屋子都收不回来：点一次不该直接生效。
    // 这里走真实点击 —— 第一次点只问一句，答完才真删；取消之后必须回到原样，
    // 而且「别人屋里的成员身份」「整间屋子的记录」都不该被一次误点带走。
    if (wants(shot, 'confirm-delete')) {
      await openSettings(cdp, sessionId)
      // React 一帧之后才重渲染，点击后给一帧的时间再读状态。
      const chipState = () =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const button = (label) =>
              [...document.querySelectorAll('button')].some((n) => n.textContent.trim() === label)
            return {
              ask: document.querySelectorAll('.cr-agent-ask').length,
              names: [...document.querySelectorAll('.cr-agent-chip')].map((n) => String(n.textContent).trim()),
              confirmText: (document.querySelector('.cr-confirm-text') || {}).textContent || null,
              dissolveBtn: button('解散房间'),
              dissolveYes: button('确定解散'),
              rooms: document.querySelectorAll('.cr-room').length,
            }
          })()`,
        )
      const before = await chipState()
      const botsBefore = before.names.length
      if (!botsBefore) throw new Error('这一屏的「我的 agent」是空的，这条断言没东西可点')

      // 1) 点 × 只问一句：agent 还在，也还没有走到「真的删掉」那一步
      const askClicked = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const btn = document.querySelector('.cr-agent-chip .cr-agent-x')
          if (!btn) return false
          btn.click()
          return true
        })()`,
      )
      if (!askClicked) throw new Error('点不到 agent 上的 ×')
      await sleep(320)
      const asking = await chipState()
      if (asking.ask !== 1) throw new Error(`点一次 × 没有进入确认态：${JSON.stringify(asking)}`)
      if (asking.names.length !== botsBefore) {
        throw new Error(`还没确认就把 agent 删了：${botsBefore} → ${asking.names.length}`)
      }

      // 2) 取消之后回到原来那颗
      const cancelled = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const btn = document.querySelector('.cr-agent-ask .cr-agent-x')
          if (!btn) return false
          btn.click()
          return true
        })()`,
      )
      if (!cancelled) throw new Error('确认态上点不到取消')
      await sleep(320)
      const back = await chipState()
      if (back.ask !== 0 || back.names.length !== botsBefore) {
        throw new Error(`取消之后没回到原样：${JSON.stringify(back)}`)
      }

      // 3) 解散房间：点一次只出「确定解散」，屋子还在列表里（规则在主面板，先关掉设置）
      await closeSettings(cdp, sessionId)
      const openedRules = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const btn = [...document.querySelectorAll('button')].find((n) => n.textContent.trim() === '规则')
          if (!btn) return false
          btn.click()
          return true
        })()`,
      )
      if (!openedRules) throw new Error('点不到「规则」')
      await sleep(320)
      const roomsBeforeDissolve = (await chipState()).rooms
      const clickedDissolve = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const btn = [...document.querySelectorAll('button')].find((n) => n.textContent.trim() === '解散房间')
          if (!btn) return false
          btn.click()
          return true
        })()`,
      )
      if (!clickedDissolve) throw new Error('点不到「解散房间」')
      await sleep(350)
      const guarded = await chipState()
      if (!guarded.confirmText || !/没了/.test(guarded.confirmText)) {
        throw new Error(`解散没有先说清后果：${JSON.stringify(guarded)}`)
      }
      if (guarded.rooms !== roomsBeforeDissolve) {
        throw new Error(`还没确认就把屋子解散了：${roomsBeforeDissolve} → ${guarded.rooms}`)
      }
      if (guarded.dissolveBtn || !guarded.dissolveYes) {
        throw new Error(`确认态里还留着原来那颗「解散房间」，容易连点两次：${JSON.stringify(guarded)}`)
      }

      // 4) 点取消退回去，屋子还在
      const cancelledDissolve = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const row = document.querySelector('.cr-confirm-row')
          const btn = row && [...row.querySelectorAll('button')].find((n) => n.textContent.trim() === '取消')
          if (!btn) return false
          btn.click()
          return true
        })()`,
      )
      if (!cancelledDissolve) throw new Error('确认态上点不到取消')
      await sleep(320)
      const restored = await chipState()
      if (!restored.dissolveBtn || restored.confirmText) {
        throw new Error(`取消之后没回到「解散房间」：${JSON.stringify(restored)}`)
      }
      if (restored.rooms !== roomsBeforeDissolve) throw new Error('取消解散之后屋子数变了')
      console.log('verified — 删 agent / 解散屋子都要先问一句：点一次不生效，取消后原样')
    }

    // 新建房间要自己挑颜色：八档、没挑时「创建」是灰的、而且说清为什么。
    if (wants(shot, 'new-room')) {
      const state = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const form = document.querySelector('.cr-create-form')
          const text = (node) => (node ? String(node.textContent).trim() : '')
          const create = form && form.querySelector('button.cr-primary')
          return {
            form: Boolean(form),
            swatches: form ? form.querySelectorAll('.cr-sw-dot').length : 0,
            hint: text(form && form.querySelector('.cr-hint')),
            disabled: create ? create.disabled : null,
          }
        })()`,
      )
      if (!state.form) throw new Error('点开「+ 新建房间」之后没有表单')
      if (state.swatches !== 8) throw new Error(`建屋表单里的虎鲸颜色不是八档：${state.swatches}`)
      if (!state.disabled) throw new Error('没挑颜色时「创建」居然能按')
      if (!/选一档/.test(state.hint)) throw new Error(`没挑颜色时没有说清为什么要挑：${JSON.stringify(state.hint)}`)
      console.log('verified — 新建房间：八档颜色，没挑之前「创建」是灰的，并写明要先挑')
    }

    // 加入失败：这是第二台机器的人最可能撞上的状态（地址写错、那台没开、码不对）。
    // 界面必须说人话、把填过的内容留着，而且不能在列表里留下半间屋子让人以为进去了。
    if (wants(shot, 'join-error')) {
      const state = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const text = (node) => (node ? String(node.textContent).trim() : '')
          return {
            error: text(document.querySelector('.cr-error-bar')),
            inputs: [...document.querySelectorAll('input.cr-field')].map((node) => node.value),
            rooms: document.querySelectorAll('.cr-room').length,
            joinButton: [...document.querySelectorAll('button.cr-primary')].some(
              (node) => node.textContent.trim() === '加入',
            ),
            // 颜色是进屋前自己挑的：表单里八档、恰好一档选中。
            swatches: document.querySelectorAll('.cr-join-form .cr-sw-dot').length,
            picked: document.querySelectorAll('.cr-join-form .cr-sw-dot[aria-pressed="true"]').length,
          }
        })()`,
      )
      if (!/连不上/.test(state.error)) throw new Error(`报错没说清是连不上：${JSON.stringify(state.error)}`)
      if (state.swatches !== 8) throw new Error(`加入表单里的虎鲸颜色不是八档：${state.swatches}`)
      if (state.picked !== 1) throw new Error(`加入表单里没有恰好选中一档颜色：${state.picked}`)
      if (!state.error.includes(joinFailTarget)) {
        throw new Error(`报错里没有对方地址（${joinFailTarget}），用户不知道该改哪：${JSON.stringify(state.error)}`)
      }
      // 「（fetch failed）」这种底层消息对用户等于没说：原因得翻成人话。
      if (/fetch failed|ECONNREFUSED|lan_unreachable|rpc_failed|Error:/.test(state.error)) {
        throw new Error(`报错里漏了内部错误码，人看不懂：${JSON.stringify(state.error)}`)
      }
      if (!/没在监听这个端口|连接超时|网络到不了|地址查不到|连接被对面断掉/.test(state.error)) {
        throw new Error(`报错没说清是哪一类原因：${JSON.stringify(state.error)}`)
      }
      if (!state.inputs.includes(joinFailTarget) || !state.inputs.includes('ZZZZZZ')) {
        throw new Error(`填过的地址/房间码被清掉了，得从零再敲一遍：${JSON.stringify(state.inputs)}`)
      }
      if (!state.joinButton) throw new Error('加入失败后表单自己收起来了')
      if (state.rooms !== joinFailRooms) {
        throw new Error(`加入失败却在房间列表里留下了屋子：${joinFailRooms} → ${state.rooms}`)
      }
      console.log(`verified — 加入失败：「${state.error}」，地址与码都还在，房间列表没变`)
    }

    // agent 的职责决定它怎么说话，所以它必须能改，而且要改得掉、改得回来。
    // 这条走真实渲染 + 真实命令：点成员行的「改」→ 表单原地展开 → 改职责 → 保存 →
    // 成员列上的职责当场换掉；再改回原值，别把后面的截图带脏。
    if (wants(shot, 'agent-edit')) {
      const roleOf = (name) =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const row = [...document.querySelectorAll('.cr-member')]
              .find((el) => (el.querySelector('.cr-member-name') || {}).textContent === ${JSON.stringify(name)})
            if (!row) return null
            const role = row.querySelector('.cr-member-role')
            return role ? role.textContent : null
          })()`,
        )
      const openEditor = (name) =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const row = [...document.querySelectorAll('.cr-member')]
              .find((el) => (el.querySelector('.cr-member-name') || {}).textContent === ${JSON.stringify(name)})
            if (!row) return false
            const button = [...row.querySelectorAll('.cr-icon-btn')].find((el) => el.textContent.trim() === '改')
            if (!button) return false
            button.click()
            return true
          })()`,
        )
      const setRole = (value) =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const input = [...document.querySelectorAll('.cr-agent-form input')]
              .find((el) => (el.getAttribute('aria-label') || '').startsWith('职责'))
            if (!input) return false
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
            setter.call(input, ${JSON.stringify(value)})
            input.dispatchEvent(new Event('input', { bubbles: true }))
            const save = [...document.querySelectorAll('.cr-agent-form button')].find((el) => el.textContent.trim() === '保存')
            if (!save) return false
            save.click()
            return true
          })()`,
        )
      const waitRole = async (name, expected) => {
        for (let i = 0; i < 60; i += 1) {
          if ((await roleOf(name)) === expected) return true
          await sleep(100)
        }
        return false
      }

      const original = await roleOf('账期 agent')
      if (!original) throw new Error('成员列里找不到「账期 agent」，这条断言没法成立')
      if (!(await openEditor('账期 agent'))) throw new Error('点不开 agent 的「改」')
      const changed = '盯 45 天账期、返点与对账单'
      if (!(await setRole(changed))) throw new Error('agent 表单里改不了职责')
      if (!(await waitRole('账期 agent', changed))) {
        throw new Error(`改完职责成员列没跟着换：${await roleOf('账期 agent')}`)
      }
      if (!(await openEditor('账期 agent'))) throw new Error('第二次点不开 agent 的「改」')
      if (!(await setRole(original))) throw new Error('agent 表单里改不回原职责')
      if (!(await waitRole('账期 agent', original))) {
        throw new Error(`职责没改回去，后面的截图会带着脏状态：${await roleOf('账期 agent')}`)
      }
      console.log('verified — agent 的职责可改：表单原地展开，成员列当场换，再改回来')
    }

    // 名字是身份的一部分：输入框里必须是坐在键盘前的这个人，改完要真的落到宿主
    // （成员列换成新名字），再改回去，别把后面的截图带脏。
    // 断言只认成员列，不认输入框：输入框里还有你正在打的草稿，看它等于什么都没证明。
    if (wants(shot, 'name-edit')) {
      await openSettings(cdp, sessionId)
      const memberNames = () =>
        evaluate(
          cdp,
          sessionId,
          `Array.from(document.querySelectorAll('.cr-member-name')).map((el) => el.textContent)`,
        )
      const readName = () =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const el = document.querySelector('.cr-settings .cr-name-row input')
            return el ? el.value : null
          })()`,
        )
      const typeName = (value) =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const el = document.querySelector('.cr-settings .cr-name-row input')
            if (!el) return false
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
            el.focus()
            setter.call(el, ${JSON.stringify(value)})
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.blur()
            return true
          })()`,
        )
      const waitForMember = async (label, gone) => {
        for (let i = 0; i < 60; i += 1) {
          const seen = await memberNames()
          if (seen.includes(label) && !seen.includes(gone)) return true
          await sleep(100)
        }
        return false
      }

      const clearName = () =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const el = document.querySelector('.cr-settings .cr-name-row input')
            if (!el) return false
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
            el.focus()
            setter.call(el, '')
            el.dispatchEvent(new Event('input', { bubbles: true }))
            return true
          })()`,
        )

      const before = await readName()
      if (before !== '林岸') throw new Error(`名字输入框里应该是本机这个人的名字，实际是 ${JSON.stringify(before)}`)

      // 先删干净。这里曾经有个很难受的毛病：删掉最后一个字，输入框立刻把旧名字顶回来，
      // 人再打字就变成「旧名字 + 新名字」—— 在默认名字叫「我」的机器上表现为
      // 「这个名字里必须带一个我」。空就是空，不能自己长回来。
      await clearName()
      await sleep(150)
      const emptied = await readName()
      if (emptied !== '') {
        throw new Error(`把名字删干净之后输入框又长回了 ${JSON.stringify(emptied)}，人接着打字就会带着它`)
      }

      await typeName('林岸·改')
      if (!(await waitForMember('林岸·改', '林岸'))) {
        throw new Error(`改完名字没落到宿主，成员列是 ${JSON.stringify(await memberNames())}`)
      }
      // 等成员列先变，再改回去：提交时比的是「和当前名字一样就不发请求」，
      // 拿着旧快照去改会正好撞上这条。
      await typeName('林岸')
      if (!(await waitForMember('林岸', '林岸·改'))) {
        throw new Error(`名字没改回去，后面的截图会带着脏状态：${JSON.stringify(await memberNames())}`)
      }
      if ((await readName()) !== '林岸') throw new Error('改完之后输入框没有回到当前名字')
      await closeSettings(cdp, sessionId)
      console.log('verified — 名字可改：删干净不会自己长回来，成员列当场换名字，再改回来')
    }

    // 邀请条上那句地址是对方唯一要抄的东西，得和宿主此刻的真实网卡排出来的一致：
    // 虚拟网卡不能占着第一个（本机能通、隔壁那台永远超时），其余的必须列出来并标明。
    if (wants(shot, 'invite-address')) {
      const truth = await (await fetch(`http://127.0.0.1:${port}/preview/lan`)).json()
      const shown = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const row = document.querySelector('.cr-invite .cr-invite-row code')
          const notes = [...document.querySelectorAll('.cr-invite .cr-invite-note')].map((node) => String(node.textContent).trim())
          return { address: row ? String(row.textContent).trim() : '', notes }
        })()`,
      )
      if (!/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(shown.address)) {
        throw new Error(`邀请条上的地址不成形：${JSON.stringify(shown.address)}`)
      }
      const shownHost = shown.address.split(':')[0]
      const candidates = truth.addresses ?? []
      const real = candidates.filter((row) => !row.virtual)
      if (real.length && shownHost !== real[0].address) {
        throw new Error(`邀请条递出去的是 ${shownHost}，而能连上的第一个是 ${real[0].address}`)
      }
      for (const row of candidates.filter((item) => item.virtual && item.address !== shownHost)) {
        const listed = shown.notes.find((note) => note.includes(row.address))
        if (!listed) throw new Error(`虚拟网卡地址没列出来，人只能自己去猜：${row.address} / ${JSON.stringify(shown.notes)}`)
        if (!/虚拟/.test(listed)) throw new Error(`虚拟网卡没被标出来：${listed}`)
      }
      console.log(`verified — 邀请地址递的是能连上的那个（${shownHost}），其余地址列在下面并标出虚拟网卡`)
    }

    // 截图只证明「出现了未读」，还得证明它「会消」：展开浮窗就等于看过了，
    // 徽标和标题前缀都该归零。这条断言跑在真实渲染的页面里，和截图同一份代码。
    if (wants(shot, 'read')) {
      // 先确认「该有未读」：没有未读的截图证明不了提醒链路，后一步的清零也就成了空跑。
      const before = await evaluate(
        cdp,
        sessionId,
        `({ badges: document.querySelectorAll('.cr-badge, .cr-nav-badge').length, title: document.title })`,
      )
      if (!(before.badges > 0 || String(before.title).startsWith('('))) {
        throw new Error(`通知没有出现未读：${JSON.stringify(before)}`)
      }
      // 「有未读」还不够，得让数字读得出来：默认主题里 brand-primary 本身是近白，
      // 徽标原来写死 color:#fff，实测 1.04:1 —— 截图看着像一坨白点，数字其实是白的。
      const readable = await evaluate(
        cdp,
        sessionId,
        `(() => {
  const parse = (value) => {
    const hit = String(value).match(/rgba?\\(([^)]+)\\)/)
    if (!hit) return null
    const parts = hit[1].split(',').map((row) => Number(row.trim()))
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }
  const luminance = (color) => {
    const channel = (value) => {
      const scaled = value / 255
      return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
  }
  return [...document.querySelectorAll('.cr-badge, .cr-nav-badge')].map((node) => {
    const style = getComputedStyle(node)
    const fg = parse(style.color)
    const bg = parse(style.backgroundColor)
    if (!fg || !bg || bg.a === 0) {
      return { text: String(node.textContent).trim(), fg: style.color, bg: style.backgroundColor, ratio: 0 }
    }
    const light = Math.max(luminance(fg), luminance(bg))
    const dark = Math.min(luminance(fg), luminance(bg))
    return {
      text: String(node.textContent).trim(),
      fg: style.color,
      bg: style.backgroundColor,
      ratio: Math.round((light + 0.05) / (dark + 0.05) * 100) / 100,
    }
  })
})()`,
      )
      const weak = readable.filter((row) => row.ratio < 4.5)
      if (weak.length) {
        throw new Error(`未读数字在徽标上读不清（对比度低于 4.5:1，甚至白字白底）：${JSON.stringify(weak)}`)
      }
      console.log(`verified — 未读数字是反色的：${readable.map((row) => `${row.text}→${row.ratio}:1`).join('、')}`)
      const opened = await evaluate(cdp, sessionId, `(() => {
        const node = document.querySelector('.cr-float-pill')
        if (!node) return false
        node.click()
        return true
      })()`)
      if (!opened) throw new Error('点不开浮窗，读不到已读路径')
      let cleared = false
      for (let i = 0; i < 60; i += 1) {
        const left = await evaluate(
          cdp,
          sessionId,
          `document.querySelectorAll('.cr-badge, .cr-nav-badge').length`,
        )
        const title = await evaluate(cdp, sessionId, 'document.title')
        if (left === 0 && !String(title).startsWith('(')) {
          cleared = true
          break
        }
        await sleep(100)
      }
      if (!cleared) throw new Error('展开浮窗后未读没有清零')
      console.log('verified — 展开浮窗后未读归零（徽标与标题前缀都落回去）')
    }
    // 三台机器同屋：两台远程机器不能都只显示一个「LAN」——
    // 认不出是哪台机器，用户就会把两台机器的人和 agent 搞混。这条断言跑在真实渲染的页面上。
    if (wants(shot, 'three-parties')) {
      const state = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const text = (node) => (node ? String(node.textContent).trim() : '')
          const rows = [...document.querySelectorAll('.cr-msg')].map((row) => ({
            name: text(row.querySelector('.cr-msg-name')).replace(/（.*?）/g, '').trim(),
            chip: text(row.querySelector('.cr-msg-meta .cr-chip.cr-lan')),
          }))
          const members = [...document.querySelectorAll('.cr-member-name')].map(text)
          // 每人一只虎鲸：成员列上每一行的头像色，就是这间屋里他坐的那一档。
          const colors = [...document.querySelectorAll('.cr-member')].map((row) => {
            const avatar = row.querySelector('.cr-avatar')
            return avatar ? getComputedStyle(avatar).color : null
          })
          return { rows, members, colors }
        })()`,
      )
      const wantMembers = ['林岸', '账期 agent', '退货 agent', '周荻', '尾货 agent', '陈默', '库存 agent']
      const missing = wantMembers.filter((name) => !state.members.includes(name))
      if (missing.length) throw new Error(`成员列少了：${missing.join('、')}（实际 ${state.members.join('、')}）`)
      const palette = new Set(state.colors.filter(Boolean))
      if (palette.size !== wantMembers.length) {
        throw new Error(
          `同一间屋里 ${wantMembers.length} 个成员应该有 ${wantMembers.length} 种虎鲸色，实际 ${palette.size} 种：${JSON.stringify(state.colors)}`,
        )
      }

      const byMachine = {
        '周荻的 MacBook': ['周荻', '尾货 agent'],
        '陈默的 ThinkPad': ['陈默', '库存 agent'],
      }
      for (const [machine, authors] of Object.entries(byMachine)) {
        for (const author of authors) {
          const row = state.rows.find((item) => item.name === author)
          if (!row) throw new Error(`消息行里没有 ${author} 的发言，这条验不了跨机器来源`)
          if (!row.chip.includes(machine)) {
            throw new Error(`${author} 的消息没有标出它来自「${machine}」，实际 chip：${JSON.stringify(row.chip)}`)
          }
        }
      }
      // 本机的成员不能被贴 LAN 标签（三台机器时最容易把自家的也标成远程）。
      for (const author of ['林岸', '账期 agent', '退货 agent']) {
        const row = state.rows.find((item) => item.name === author)
        if (row && row.chip) throw new Error(`本机成员 ${author} 被标成了 LAN：${JSON.stringify(row.chip)}`)
      }
      const machines = new Set(state.rows.map((row) => row.chip).filter(Boolean))
      if (machines.size < 2) throw new Error(`两台远程机器没有区分开：${JSON.stringify([...machines])}`)
      console.log(`verified — 三台机器同屋：${wantMembers.length} 个成员、两台远程机器各标自己的机器名`)
    }
    // 「agent 怎么进来」：加入那一刻只带得走本机**已有的** agent，新机器上一个都没有。
    // 这一屏要证明补报那条路是通的：那台机器建完 agent，我这边成员列立刻多一个人、
    // 认得出是哪台机器的、而且 @ 它真的把这一轮派回去跑；左栏「我的 agent」能建能删。
    if (wants(shot, 'bring-agent')) {
      // 「我的 agent」现在住在设置弹窗里，后面既读它们的 chip 也要点新建入口。
      await openSettings(cdp, sessionId)
      const read = () =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const text = (node) => (node ? String(node.textContent).trim() : '')
            const members = [...document.querySelectorAll('.cr-member')].map((row) => {
              const chip = row.querySelector('.cr-chip.cr-lan')
              return {
                name: text(row.querySelector('.cr-member-name')),
                lan: Boolean(chip),
                title: chip ? String(chip.getAttribute('title') || '') : '',
              }
            })
            const rows = [...document.querySelectorAll('.cr-msg')].map((row) => ({
              name: text(row.querySelector('.cr-msg-name')).replace(/（.*?）/g, '').trim(),
              chip: text(row.querySelector('.cr-msg-meta .cr-chip.cr-lan')),
            }))
            const chips = [...document.querySelectorAll('.cr-agent-chip .cr-agent-name')].map(text)
            return { members, rows, chips }
          })()`,
        )
      const find = (state, name) => state.members.find((row) => row.name === name)

      const state = await read()
      for (const name of ['陈默', '库存 agent']) {
        const row = find(state, name)
        if (!row) throw new Error(`成员列里没有「${name}」：${JSON.stringify(state.members.map((item) => item.name))}`)
        if (!row.lan) throw new Error(`「${name}」是别的机器上的，却没标 LAN`)
      }
      if (!/陈默的 ThinkPad/.test(find(state, '库存 agent').title)) {
        throw new Error(`认不出「库存 agent」是哪台机器带的：${JSON.stringify(find(state, '库存 agent').title)}`)
      }
      if (find(state, '林岸') && find(state, '林岸').lan) throw new Error('本机的人被贴成了 LAN')
      const reply = state.rows.find((row) => row.name === '库存 agent')
      if (!reply) throw new Error('消息里没有「库存 agent」的回复，这一轮没派回那台机器')
      if (!/陈默的 ThinkPad/.test(reply.chip)) throw new Error(`回复的来源没标出机器：${JSON.stringify(reply.chip)}`)

      // 左栏「我的 agent」：自己带的 agent 都在这儿，而且能建、能删。
      for (const name of ['账期 agent', '退货 agent']) {
        if (!state.chips.includes(name)) throw new Error(`「我的 agent」里少了 ${name}：${JSON.stringify(state.chips)}`)
      }
      const opened = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const button = [...document.querySelectorAll('.cr-settings .cr-link-btn')].find((node) =>
            node.textContent.includes('新建一个 agent'),
          )
          if (!button) return false
          button.click()
          return true
        })()`,
      )
      if (!opened) throw new Error('点不开「我的 agent」里的新建入口')
      const filled = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const inputs = [...document.querySelectorAll('.cr-my-form input')]
          if (inputs.length < 2) return false
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          const put = (el, value) => {
            el.focus()
            setter.call(el, value)
            el.dispatchEvent(new Event('input', { bubbles: true }))
          }
          put(inputs[0], '临时 agent')
          put(inputs[1], '断言建的，建完就删')
          return true
        })()`,
      )
      if (!filled) throw new Error('「我的 agent」的表单没展开出名字与职责两栏')
      await evaluate(
        cdp,
        sessionId,
        `(() => {
          const button = [...document.querySelectorAll('.cr-my-form button')].find((node) => node.textContent.trim() === '保存')
          if (!button) return false
          button.click()
          return true
        })()`,
      )
      let created = null
      for (let i = 0; i < 60; i += 1) {
        created = await read()
        if (created.chips.includes('临时 agent') && find(created, '临时 agent')) break
        await sleep(100)
      }
      if (!created.chips.includes('临时 agent')) {
        throw new Error(`建完的 agent 没进「我的 agent」：${JSON.stringify(created.chips)}`)
      }
      if (!find(created, '临时 agent')) throw new Error('建完的 agent 没进这间屋子')

      // 删掉 agent 不是一次点击的事：先点 × 只会问一句，答完才真删。
      await evaluate(
        cdp,
        sessionId,
        `(() => {
          const chip = [...document.querySelectorAll('.cr-agent-chip')].find((row) =>
            String(row.textContent).includes('临时 agent'),
          )
          const button = chip && chip.querySelector('.cr-agent-x')
          if (!button) return false
          button.click()
          return true
        })()`,
      )
      let asked = false
      for (let i = 0; i < 40; i += 1) {
        asked = await evaluate(
          cdp,
          sessionId,
          `(() => {
            const rows = [...document.querySelectorAll('.cr-agent-ask')]
            return rows.length === 1 && /删掉/.test(String(rows[0].textContent))
          })()`,
        )
        if (asked) break
        await sleep(80)
      }
      if (!asked) throw new Error('点一次 × 没进入「删掉它？」的确认态')
      // 确认态里那颗 chip 已经不显示名字了（换成了「删掉它？」），所以「还在不在」
      // 要看成员列和 chip 数量：成员列里那个 agent 必须还在，说明没提前删。
      const pending = await evaluate(
        cdp,
        sessionId,
        `(() => ({
          members: [...document.querySelectorAll('.cr-member-name')].map((n) => n.textContent.trim()),
          chips: document.querySelectorAll('.cr-agent-chip').length,
        }))()`,
      )
      if (!pending.members.includes('临时 agent')) {
        throw new Error(`还没确认就把 agent 从屋里删走了：${JSON.stringify(pending.members)}`)
      }
      const confirmed = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const button = document.querySelector('.cr-agent-ask .cr-agent-yes')
          if (!button) return false
          button.click()
          return true
        })()`,
      )
      if (!confirmed) throw new Error('确认态上点不到「删掉」')
      let removed = null
      for (let i = 0; i < 60; i += 1) {
        removed = await read()
        if (!removed.chips.includes('临时 agent') && !find(removed, '临时 agent')) break
        await sleep(100)
      }
      if (removed.chips.includes('临时 agent') || find(removed, '临时 agent')) {
        throw new Error('删掉的 agent 还留在「我的 agent」或成员列里')
      }
      await closeSettings(cdp, sessionId)
      // 这一屏专开的演示例房间收掉：后面的截图不该带着上一屏的故事。
      await fetch(`http://127.0.0.1:${port}/preview/tidy`)
      console.log('verified — 空手加入的机器补建 agent：成员列当场多一个 LAN·陈默的 ThinkPad，@ 它能跑一轮；左栏能建、删之前先问一句')
    }
    // 两台机器的插件版本不一样：老机器报不了 agent 名单，界面必须说清是哪台、该做什么。
    // 「每台机器带了谁」是宿主这边唯一的反馈回路 —— 少了它，用户只能看到 agent 没进来。
    if (wants(shot, 'old-peer')) {
      const state = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const text = (node) => (node ? String(node.textContent).trim() : '')
          return {
            peers: [...document.querySelectorAll('.cr-peer')].map((row) => ({
              machine: text(row.querySelector('.cr-peer-machine')),
              state: text(row.querySelector('.cr-peer-state, .cr-warn')),
              old: Boolean(row.querySelector('.cr-warn')),
            })),
            members: [...document.querySelectorAll('.cr-member-name')].map(text),
          }
        })()`,
      )
      const peer = state.peers.find((row) => row.machine === '阿青的 Surface')
      if (!peer) throw new Error(`没有列出那台机器：${JSON.stringify(state.peers)}`)
      if (!peer.old) throw new Error('旧版本那台没被标出来：界面会让人以为「它只是还没建 agent」')
      if (!/旧版本/.test(peer.state)) throw new Error(`提示没说清是版本问题：${JSON.stringify(peer.state)}`)
      if (!/重启/.test(peer.state)) throw new Error(`提示没给出该做的事：${JSON.stringify(peer.state)}`)
      if (!state.members.includes('阿青')) throw new Error(`屋里应该有这个人：${JSON.stringify(state.members)}`)
      if (state.members.some((name) => /agent/.test(name) && !/账期|退货/.test(name))) {
        throw new Error(`旧版本那台不可能带着 agent 成员：${JSON.stringify(state.members)}`)
      }
      await fetch(`http://127.0.0.1:${port}/preview/tidy`)
      console.log('verified — 版本不一致：列出「阿青的 Surface · 旧版本，报不了 agent 名单 —— 重启那台的桌面端」')
    }
    // 浮窗既然能拖到任何地方，就得证明它拖不丢：记住的坐标要真的用上、越界的坐标要夹回、
    // 拖到屏幕外要夹住、窗口变窄以后还得在视口里。四条都跑在真实渲染的页面里。
    if (wants(shot, 'float-bounds')) {
      const openCard = async () => {
        await waitForSelector(cdp, sessionId, '.cr-float-pill')
        await evaluate(cdp, sessionId, `(() => {
          const node = document.querySelector('.cr-float-pill')
          if (!node) return false
          node.click()
          return true
        })()`)
        await waitForSelector(cdp, sessionId, '.cr-float-card')
      }

      // 1. 记住的位置要真的被用上 —— 存到一个跟默认角落明显不同的地方再重开页面。
      await evaluate(
        cdp,
        sessionId,
        `localStorage.setItem('dsh-chatroom:float-pos:v1', JSON.stringify({ x: 100, y: 120 }))`,
      )
      await cdp.send('Page.reload', {}, sessionId)
      await openCard()
      const remembered = await boundsOf(cdp, sessionId, '.cr-float-card')
      if (!remembered || Math.abs(remembered.left - 100) > 2 || Math.abs(remembered.top - 120) > 2) {
        throw new Error(`重开页面后没有回到记住的位置：${JSON.stringify(remembered)}`)
      }

      // 2. 存的坐标在屏幕外（上次窗口更大时拖出去的）时，要夹回视口。
      await evaluate(
        cdp,
        sessionId,
        `localStorage.setItem('dsh-chatroom:float-pos:v1', JSON.stringify({ x: 99999, y: 99999 }))`,
      )
      await cdp.send('Page.reload', {}, sessionId)
      await openCard()
      assertInside(await boundsOf(cdp, sessionId, '.cr-float-card'), '存下来的越界坐标没有夹回视口')

      // 3. 拖到屏幕外：松手以后就再也没有第二个抓手了，必须在拖动过程中就夹住。
      const dragged = await evaluate(cdp, sessionId, `(() => {
        const head = document.querySelector('.cr-float-head')
        if (!head) return false
        const box = head.getBoundingClientRect()
        const at = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true })
        head.dispatchEvent(new PointerEvent('pointerdown', at(box.left + 16, box.top + 8)))
        window.dispatchEvent(new PointerEvent('pointermove', at(9999, 9999)))
        window.dispatchEvent(new PointerEvent('pointerup', at(9999, 9999)))
        return true
      })()`)
      if (!dragged) throw new Error('抓不到浮窗标题栏，拖动这条验不了')
      await sleep(200)
      assertInside(await boundsOf(cdp, sessionId, '.cr-float-card'), '拖到屏幕外没有被夹住')

      // 4. 窗口被拖窄：记住的坐标不变，但浮窗得留在看得见的地方。
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: 1024, height: 700, deviceScaleFactor: 2, mobile: false },
        sessionId,
      )
      await sleep(300)
      assertInside(await boundsOf(cdp, sessionId, '.cr-float-card'), '窗口变窄后浮窗跑到视口外')
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
        sessionId,
      )
      await sleep(300)

      // 5. 收起成胶囊以后那颗胶囊也得能拖。收起态是另一个 DOM（.cr-float-pill），
      //    拖动监听要是跟着 floatOpen 一起关掉，这里就一步也拖不动。
      await evaluate(cdp, sessionId, `(() => {
        const close = document.querySelector('.cr-float-head .cr-icon-btn')
        if (!close) return false
        close.click()
        return true
      })()`)
      await waitForSelector(cdp, sessionId, '.cr-float-pill')
      const pillDrag = await evaluate(cdp, sessionId, `(() => {
        const pill = document.querySelector('.cr-float-pill')
        if (!pill) return 'no-pill'
        const box = pill.getBoundingClientRect()
        const at = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 })
        // 只抖 2px 不能算拖：那一下松手要按点击处理，点一下才是展开。
        const wobble = { x: box.left + 20, y: box.top + 16 }
        pill.dispatchEvent(new PointerEvent('pointerdown', at(wobble.x, wobble.y)))
        window.dispatchEvent(new PointerEvent('pointermove', at(wobble.x + 2, wobble.y + 2)))
        window.dispatchEvent(new PointerEvent('pointerup', at(wobble.x + 2, wobble.y + 2)))
        if (document.querySelector('.cr-float-card')) return 'wobble-opened'
        const held = pill.getBoundingClientRect()
        if (Math.abs(held.left - box.left) > 1 || Math.abs(held.top - box.top) > 1) return 'wobble-moved'
        // 真正的拖动：抓住胶囊拖到 (320, 300)，抓手偏移是 (20, 16)。
        pill.dispatchEvent(new PointerEvent('pointerdown', at(held.left + 20, held.top + 16)))
        window.dispatchEvent(new PointerEvent('pointermove', at(held.left + 24, held.top + 20)))
        window.dispatchEvent(new PointerEvent('pointermove', at(320, 300)))
        window.dispatchEvent(new PointerEvent('pointerup', at(320, 300)))
        return 'ok'
      })()`)
      if (pillDrag !== 'ok') throw new Error(`收起态的胶囊拖不动：${pillDrag}`)
      await sleep(250)
      const pillBox = await boundsOf(cdp, sessionId, '.cr-float-pill')
      if (!pillBox) throw new Error('拖完以后找不到胶囊')
      if (Math.abs(pillBox.left - 300) > 2 || Math.abs(pillBox.top - 284) > 2) {
        throw new Error(`胶囊没有跟着手指走：${JSON.stringify(pillBox)}`)
      }
      assertInside(pillBox, '胶囊被拖到视口外')
      const savedPill = JSON.parse(
        (await evaluate(cdp, sessionId, `localStorage.getItem('dsh-chatroom:float-pos:v1')`)) || 'null',
      )
      if (!savedPill || Math.abs(savedPill.x - 300) > 2 || Math.abs(savedPill.y - 284) > 2) {
        throw new Error(`胶囊的位置没有存下来：${JSON.stringify(savedPill)}`)
      }
      // 从拖过去的胶囊展开：窗口要开在原地，不能跳回右下角。
      await evaluate(cdp, sessionId, `document.querySelector('.cr-float-pill').click()`)
      await waitForSelector(cdp, sessionId, '.cr-float-card')
      const openedAt = await boundsOf(cdp, sessionId, '.cr-float-card')
      if (!openedAt || Math.abs(openedAt.left - 300) > 2 || Math.abs(openedAt.top - 284) > 2) {
        throw new Error(`从拖过去的胶囊展开后没留在原地：${JSON.stringify(openedAt)}`)
      }

      // 6. 浮窗不是一块光秃秃的记录：头像 / 署名 / 时间 / @ 候选都得住在这里；
      //    收起以后那颗胶囊也得带着最后一句 —— 这几样正是这一版重做的内容，掉一个就是退回去。
      const content = await evaluate(cdp, sessionId, `(() => {
        const rows = [...document.querySelectorAll('.cr-float-msg')]
        const last = rows[rows.length - 1]
        return {
          rows: rows.length,
          avatars: document.querySelectorAll('.cr-float-msg .cr-avatar').length,
          names: document.querySelectorAll('.cr-float-msg .cr-msg-name').length,
          times: document.querySelectorAll('.cr-float-msg .cr-msg-time').length,
          mentionButton: Boolean(document.querySelector('.cr-composer-compact .cr-mention-btn')),
          lastName: last && last.querySelector('.cr-msg-name') ? last.querySelector('.cr-msg-name').textContent : '',
        }
      })()`)
      if (content.rows < 3) throw new Error(`浮窗里只剩 ${content.rows} 条消息，内容被压掉了`)
      if (content.avatars !== content.rows) throw new Error(`每条消息都该有头像：${content.avatars}/${content.rows}`)
      if (content.names !== content.rows) throw new Error(`每条消息都该有署名：${content.names}/${content.rows}`)
      if (content.times !== content.rows) throw new Error(`每条消息都该有时间：${content.times}/${content.rows}`)
      if (!content.mentionButton) throw new Error('浮窗输入框里没有 @ 按钮')
      await evaluate(cdp, sessionId, `document.querySelector('.cr-composer-compact .cr-mention-btn').click()`)
      await waitForSelector(cdp, sessionId, '.cr-mention-pop')
      const pickRows = await evaluate(
        cdp,
        sessionId,
        `[...document.querySelectorAll('.cr-mention-pop .cr-pop-row')].map((node) => node.textContent.trim())`,
      )
      if (!pickRows.length) throw new Error('浮窗里点 @ 没有列出任何 agent')
      // 收起：胶囊上要带着「谁：说了什么」，不是一个光秃秃的房间名。
      await evaluate(cdp, sessionId, `document.querySelector('.cr-float-head .cr-icon-btn').click()`)
      await waitForSelector(cdp, sessionId, '.cr-float-pill')
      const pill = await evaluate(cdp, sessionId, `(() => {
        const say = document.querySelector('.cr-float-pill-say')
        const name = document.querySelector('.cr-float-pill-name')
        return { say: say ? say.textContent : '', name: name ? name.textContent : '' }
      })()`)
      const who = content.lastName.replace('（我）', '')
      if (!pill.name) throw new Error('收起以后胶囊上没有房间名')
      if (pill.say.indexOf('：') < 0 || pill.say.indexOf(who) !== 0) {
        throw new Error(`胶囊上没有带上最后一句（应为「${who}：…」）：${JSON.stringify(pill)}`)
      }

      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
        sessionId,
      )
      await evaluate(cdp, sessionId, `localStorage.removeItem('dsh-chatroom:float-pos:v1')`)
      console.log(
        'verified — 位置记得住、越界夹回、拖动不出界、窗口变窄仍在视口内、收起成胶囊也拖得动；' +
          '浮窗里有头像 / 署名 / 时间 / 身份行与 @ 候选，胶囊收起时带着最后一句',
      )
    }

    // 「没回上来」不能只是一行灰字：得有入口把那一个 agent 单独重跑一次。
    // 这条走真实渲染 + 真实命令：点「重试」→ 客户端发 msg.retry → 宿主只重跑它一个 → 回复落库。
    if (wants(shot, 'retry')) {
      const before = await evaluate(cdp, sessionId, `(() => {
        const rows = [...document.querySelectorAll('.cr-msg')]
        const failed = rows.find((row) => row.classList.contains('cr-error'))
        if (!failed) return null
        const buttons = [...failed.querySelectorAll('.cr-msg-actions button')]
        return {
          count: rows.length,
          text: failed.querySelector('.cr-msg-text').textContent,
          buttons: buttons.length,
          label: buttons[0] ? buttons[0].textContent.trim() : null,
          disabled: buttons[0] ? buttons[0].disabled : null,
        }
      })()`)
      if (!before) throw new Error('这一屏里没有「没回上来」那条')
      if (!/没回上来/.test(before.text)) throw new Error(`失败占位的内容不对：${before.text}`)
      if (before.buttons !== 1) throw new Error(`失败那条该正好一个重试按钮，实际 ${before.buttons} 个`)
      if (before.label !== '重试') throw new Error(`重试按钮的文字不对：${before.label}`)
      if (before.disabled) throw new Error('这一轮已经结束了，重试按钮不该是禁用的')

      // 同一份状态在会话界面里再开一页：浮窗本来会把失败消息过滤掉（只留最近六条），
      // 这条要证明「失败不会被折叠掉」，并且浮窗里那个「重试」真的点得动。
      const { targetId: floatTarget } = await cdp.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId: floatSession } = await cdp.send('Target.attachToTarget', { targetId: floatTarget, flatten: true })
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
        floatSession,
      )
      await cdp.send('Page.enable', {}, floatSession)
      await cdp.send('Runtime.enable', {}, floatSession)
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/?view=session` }, floatSession)
      await waitForSelector(cdp, floatSession, '.cr-float-pill')
      await evaluate(cdp, floatSession, `document.querySelector('.cr-float-pill').click()`)
      await waitForSelector(cdp, floatSession, '.cr-float-failed')
      const inFloat = await evaluate(cdp, floatSession, `(() => {
        const row = document.querySelector('.cr-float-failed')
        const buttons = [...row.querySelectorAll('button')]
        return {
          text: row.textContent,
          buttons: buttons.length,
          label: buttons[0] ? buttons[0].textContent.trim() : null,
        }
      })()`)
      if (!/没回上来/.test(inFloat.text)) throw new Error(`浮窗里没显示失败：${inFloat.text}`)
      if (inFloat.buttons !== 1 || inFloat.label !== '重试') {
        throw new Error(`浮窗里的重试入口不对：${JSON.stringify(inFloat)}`)
      }
      await evaluate(cdp, floatSession, `document.querySelector('.cr-float-failed button').click()`)
      let floated = null
      for (let i = 0; i < 60; i += 1) {
        floated = await evaluate(cdp, floatSession, `(() => {
          const rows = [...document.querySelectorAll('.cr-float-msg')]
          const last = rows[rows.length - 1]
          return {
            failed: document.querySelectorAll('.cr-float-failed').length,
            lastText: last ? last.textContent : '',
          }
        })()`)
        if (floated.failed === 0 && /缺口 82 万/.test(floated.lastText)) break
        await sleep(100)
      }
      await cdp.send('Target.closeTarget', { targetId: floatTarget })
      if (floated.failed !== 0) throw new Error('重试成功后浮窗里还挂着那条失败')
      if (!/缺口 82 万/.test(floated.lastText)) throw new Error(`浮窗里没等到重试的回复：${floated.lastText}`)

      // 回到面板这一页：同一间屋子里的新回复也得跟着长出来（不是只在浮窗里）。
      let after = null
      for (let i = 0; i < 60; i += 1) {
        after = await evaluate(cdp, sessionId, `(() => {
          const rows = [...document.querySelectorAll('.cr-msg')]
          const last = rows[rows.length - 1]
          return {
            count: rows.length,
            lastText: last ? last.querySelector('.cr-msg-text').textContent : '',
            errorRows: rows.filter((row) => row.classList.contains('cr-error')).length,
          }
        })()`)
        if (after.count > before.count && !/没回上来/.test(after.lastText)) break
        await sleep(100)
      }
      if (after.count <= before.count) throw new Error('重试以后面板里没有新消息进来')
      if (after.errorRows !== 1) throw new Error(`失败占位不该被抹掉或翻倍：${after.errorRows} 条`)
      if (!/缺口 82 万/.test(after.lastText)) throw new Error(`重试后落库的不是那个 agent 的话：${after.lastText}`)
      console.log('verified — 失败留占位，点重试只重跑那一个 agent，回复接在后面（面板与浮窗都验过）')
    }

    // 说了一句、谁都没接：默认只有「被 @ 才回」，新用户第一句话就是这个处境。
    // 界面必须当场说清「没叫到人、怎么写才叫到」；而一旦真点到名，agent 接上话，
    // 那句解释也得自己消失 —— 否则它就变成永远挂着的噪音。
    if (wants(shot, 'no-reply')) {
      const said = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const rows = [...document.querySelectorAll('.cr-msg')]
          const hint = document.querySelector('.cr-hint')
          return {
            hint: hint ? String(hint.textContent).trim() : null,
            rows: rows.length,
            lastMine: rows.length ? rows[rows.length - 1].classList.contains('cr-mine') : false,
          }
        })()`,
      )
      if (!said.hint) throw new Error('说完一句没人接，界面上一个字都没解释')
      if (!/@/.test(said.hint)) throw new Error(`解释里没告诉人怎么写才能叫到 agent：${said.hint}`)
      if (/undefined|null|NaN/.test(said.hint)) throw new Error(`解释里有没填上的占位：${said.hint}`)
      if (!said.lastMine) throw new Error('这条解释不是挂在我刚说的那句下面')
      console.log(`verified — 没人接话时把原因说出来了：${said.hint}`)

      // 浮窗里也有输入框，也会撞上同一片安静：同一句解释得在那儿也说一遍。
      const { targetId: floatTarget } = await cdp.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId: floatSession } = await cdp.send('Target.attachToTarget', {
        targetId: floatTarget,
        flatten: true,
      })
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
        floatSession,
      )
      await cdp.send('Page.enable', {}, floatSession)
      await cdp.send('Runtime.enable', {}, floatSession)
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/?view=session` }, floatSession)
      await waitForSelector(cdp, floatSession, '.cr-float-pill')
      await evaluate(cdp, floatSession, `document.querySelector('.cr-float-pill').click()`)
      await waitForSelector(cdp, floatSession, '.cr-float-hint')
      const inFloat = await evaluate(
        cdp,
        floatSession,
        `String(document.querySelector('.cr-float-hint').textContent).trim()`,
      )
      await cdp.send('Target.closeTarget', { targetId: floatTarget })
      if (!/@/.test(inFloat)) throw new Error(`浮窗里那句解释不对：${inFloat}`)
      // 浮窗里没有「让全员说一轮」这个按钮，说法就不能照着面板抄。
      if (/全员说一轮/.test(inFloat)) throw new Error(`浮窗里指了一个它点不到的按钮：${inFloat}`)
      console.log(`verified — 浮窗里同样把原因说清楚：${inFloat}`)

      const filled = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const box = document.querySelector('textarea.cr-textarea')
          if (!box) return false
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          box.focus()
          setter.call(box, '@账期 agent 缺口按哪天的账期算的？')
          box.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        })()`,
      )
      if (!filled) throw new Error('填不进输入框')
      await sleep(200)
      const clicked = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const button = [...document.querySelectorAll('button.cr-primary')].find(
            (node) => node.textContent.trim() === '发送',
          )
          if (!button || button.disabled) return false
          button.click()
          return true
        })()`,
      )
      if (!clicked) throw new Error('点不出那句点名的话')
      let after = null
      for (let i = 0; i < 80; i += 1) {
        after = await evaluate(
          cdp,
          sessionId,
          `(() => {
            const rows = [...document.querySelectorAll('.cr-msg')]
            return {
              rows: rows.length,
              hint: document.querySelectorAll('.cr-hint').length,
              lastText: rows.length ? rows[rows.length - 1].querySelector('.cr-msg-text').textContent : '',
            }
          })()`,
        )
        if (after.rows > said.rows && after.hint === 0) break
        await sleep(100)
      }
      if (after.rows <= said.rows) throw new Error(`点名之后 agent 没有接话：${JSON.stringify(after)}`)
      if (after.hint !== 0) throw new Error('agent 接话之后那句解释还挂着')
      console.log('verified — 点名之后 agent 真接上了，那句解释自己消失')
    }

    // 长房间往回翻：投影只有最近 200 条，更早那 40 句必须真的能翻回来。
    // 这一屏的判据不是「有个按钮」：点下去要真的多出 40 条、第一条变最早那句、
    // 翻到底之后入口自己消失，而且视口没被跳走（用户还在原来那句上）。
    if (wants(shot, 'history')) {
      const readTimeline = () =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const flow = document.querySelector('.cr-flow')
            const button = document.querySelector('.cr-older-btn')
            const jump = document.querySelector('.cr-jump')
            const rows = [...document.querySelectorAll('.cr-msg')]
            return {
              rows: rows.length,
              button: button ? String(button.textContent).trim() : null,
              jump: jump ? String(jump.textContent).trim() : null,
              gap: flow ? Math.round(flow.scrollHeight - flow.scrollTop - flow.clientHeight) : null,
              first: rows.length ? String(rows[0].querySelector('.cr-msg-text').textContent).trim() : '',
              last: rows.length ? String(rows[rows.length - 1].querySelector('.cr-msg-text').textContent).trim() : '',
              scrollTop: flow ? Math.round(flow.scrollTop) : null,
              error: document.querySelector('.cr-error-bar') ? String(document.querySelector('.cr-error-bar').textContent).trim() : null,
            }
          })()`,
        )
      const before = await readTimeline()
      if (!before.button) throw new Error('长房间没有「加载更早的消息」入口：说过的话翻不回去')
      if (!/加载更早/.test(before.button)) throw new Error(`入口文案不对：${before.button}`)
      if (before.rows !== 200) throw new Error(`投影应该是最近 200 条，实际 ${before.rows}`)
      console.log(`verified — 240 句的屋子只显示最后一屏，顶端有入口：${before.button}`)

      await evaluate(cdp, sessionId, `document.querySelector('.cr-older-btn').click()`)
      let after = null
      for (let i = 0; i < 60; i += 1) {
        after = await readTimeline()
        if (after.rows > before.rows) break
        await sleep(100)
      }
      if (after.error) throw new Error(`翻历史时报错了：${after.error}`)
      if (after.rows !== 240) throw new Error(`翻完应该是 240 条，实际 ${after.rows}`)
      if (after.button) throw new Error('已经翻到最早一条，入口还挂着')
      if (!/11\/01/.test(after.first)) throw new Error(`翻到的不是最早那句：${after.first}`)
      if (!/11\/24/.test(after.last)) throw new Error(`最新那句不该被翻页换掉：${after.last}`)
      // 视口接回去是「下一帧」的事：loadOlder 在拿到那一页后用 requestAnimationFrame 补高度，
      // 上面那个轮询一看到 240 行就退出，可能正压在这一帧之前。等它落稳再断言 ——
      // 30×50ms 还回不到 0 以上，才是真的把人跳到顶上。
      for (let i = 0; i < 30 && !(after.scrollTop > 0); i += 1) {
        await sleep(50)
        after = await readTimeline()
      }
      if (!(after.scrollTop > 0)) throw new Error('翻完视口被跳回顶部：用户读的那句会掉下去')
      if (!after.jump || !/回到最新/.test(after.jump)) {
        throw new Error(`翻到上头之后没有回到最新的出口：${after.jump}`)
      }
      console.log(`verified — 点一下真翻回最早那 40 句（${after.rows} 条，首句「${after.first}」），入口自己消失`)

      // 往上翻完人停在顶上，最新那句在几百行之外：出口得真把人送回去。
      await evaluate(cdp, sessionId, `document.querySelector('.cr-jump').click()`)
      let back = null
      for (let i = 0; i < 30; i += 1) {
        back = await readTimeline()
        if (back.jump === null) break
        await sleep(100)
      }
      if (back.jump !== null) throw new Error('点了「回到最新」，出口还挂在上面')
      if (!(back.gap <= 2)) throw new Error(`点了「回到最新」却没到底：还差 ${back.gap}px`)
      if (back.rows !== after.rows) throw new Error('回到最新不该丢掉翻出来的历史')
      console.log(`verified — 「回到最新」一步回到这句（离底部 ${back.gap}px，${back.rows} 条仍在）`)

      // 停在上面读历史的时候，屋里又进来话 —— 那两句在屏幕上根本看不见。
      // 出口上必须写清「几条新的」，否则这枚按钮和一直挂着没区别。
      const parkedOk = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const flow = document.querySelector('.cr-flow')
          if (!flow) return false
          flow.scrollTop = 0
          flow.dispatchEvent(new Event('scroll'))
          return true
        })()`,
      )
      if (!parkedOk) throw new Error('滚不回上面')
      let parked = null
      for (let i = 0; i < 40; i += 1) {
        parked = await readTimeline()
        if (parked.jump) break
        await sleep(100)
      }
      if (!parked.jump) throw new Error('停在上面之后没有回到最新的出口')
      if (/条新的/.test(parked.jump)) throw new Error(`还没人说话，出口就报数了：${parked.jump}`)

      // 走页面自己的命令通道（和界面发消息同一条路），宿主真落库、长轮询真推回来。
      const liveRoom = await sayInRoom(cdp, sessionId, ['这两句是翻着历史时进来的', '第二句也一样'])
      let live = null
      for (let i = 0; i < 80; i += 1) {
        live = await readTimeline()
        if (live.rows === parked.rows + 2 && /条新的/.test(live.jump || '')) break
        await sleep(100)
      }
      if (live.rows !== parked.rows + 2) throw new Error(`新来的两句没到界面上：${parked.rows} → ${live.rows}`)
      if (live.last !== '第二句也一样') throw new Error(`最新那句不对：${live.last}`)
      if (!/回到最新 · 2 条新的/.test(live.jump)) throw new Error(`出口没写清几条新的：${live.jump}`)
      if (live.scrollTop !== parked.scrollTop) throw new Error(`来新消息把人拽走了：${parked.scrollTop} → ${live.scrollTop}`)
      console.log(`verified — 停在上头时进来的两句记在出口上：${live.jump}（${live.rows} 条，接缝补上了）`)

      await evaluate(cdp, sessionId, `document.querySelector('.cr-jump').click()`)
      let cleared = null
      for (let i = 0; i < 40; i += 1) {
        cleared = await readTimeline()
        if (cleared.jump === null) break
        await sleep(100)
      }
      if (cleared.jump !== null) throw new Error('点过之后出口还挂着')
      if (!(cleared.gap <= 2)) throw new Error(`点了「回到最新」却没到底：还差 ${cleared.gap}px`)
      console.log(`verified — 点一下回到最新，计数自己消失（离底部 ${cleared.gap}px）`)
    }

    // 「翻着历史时屋里又进来话」这一屏：出口记数、人没被拽走、接缝补上；
    // 点一下回到最新、计数清零。断言的是截图里那个冻结状态本身。
    if (wants(shot, 'history-live')) {
      const readLive = () =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const flow = document.querySelector('.cr-flow')
            const jump = document.querySelector('.cr-jump')
            const rows = [...document.querySelectorAll('.cr-msg')]
            return {
              rows: rows.length,
              jump: jump ? String(jump.textContent).trim() : null,
              gap: flow ? Math.round(flow.scrollHeight - flow.scrollTop - flow.clientHeight) : null,
              last: rows.length ? String(rows[rows.length - 1].querySelector('.cr-msg-text').textContent).trim() : '',
              error: document.querySelector('.cr-error-bar') ? String(document.querySelector('.cr-error-bar').textContent).trim() : null,
            }
          })()`,
        )
      const live = await readLive()
      if (live.error) throw new Error(`这一屏报错了：${live.error}`)
      if (!live.jump || !/回到最新 · 2 条新的/.test(live.jump)) throw new Error(`出口没写清几条新的：${live.jump}`)
      if (live.rows !== 242) throw new Error(`时间线该是 242 条（240 + 新来的两句），实际 ${live.rows}`)
      if (live.last !== '第二句也一样') throw new Error(`最新那句不对：${live.last}`)
      if (!(live.gap > 200)) throw new Error(`这张图该是「人停在上头」：离底部只有 ${live.gap}px`)
      console.log(`verified — 翻着历史时进来的两句记在出口上：${live.jump}（${live.rows} 条，离底部 ${live.gap}px）`)
      await evaluate(cdp, sessionId, `document.querySelector('.cr-jump').click()`)
      let cleared = null
      for (let i = 0; i < 40; i += 1) {
        cleared = await readLive()
        if (cleared.jump === null) break
        await sleep(100)
      }
      if (cleared.jump !== null) throw new Error('点过之后出口还挂着')
      if (!(cleared.gap <= 2)) throw new Error(`点了「回到最新」却没到底：还差 ${cleared.gap}px`)
      console.log(`verified — 点一下回到最新，计数自己消失（离底部 ${cleared.gap}px）`)
    }
    // 中文输入法里回车是「选词」，不是「发送」。
    // 浏览器把拼字中的那一下标成 isComposing，老输入法只给 keyCode 229；
    // 不认这个标记，拼音打到一半按回车就把半截话发进屋里 —— 面板和浮窗一样。
    // 这条检查最后会真发一句出去（证明回车仍然能发），所以只能挂在最后一屏：
    // 那时截图已经拍完，屋里多这一句不影响任何 PNG。
    if (wants(shot, 'ime-enter')) {
      if (shots.at(-1).name !== shot.name) {
        throw new Error('ime-enter 会真发一句，只能挂在最后一屏；往后加屏时请把它一起搬过去')
      }
      const { targetId: imeTarget } = await cdp.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId: imeSession } = await cdp.send('Target.attachToTarget', {
        targetId: imeTarget,
        flatten: true,
      })
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
        imeSession,
      )
      await cdp.send('Page.enable', {}, imeSession)
      await cdp.send('Runtime.enable', {}, imeSession)
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/?view=session` }, imeSession)
      await waitForSelector(cdp, imeSession, '.cr-float-pill')
      await evaluate(cdp, imeSession, `document.querySelector('.cr-float-pill').click()`)
      await waitForSelector(cdp, imeSession, '.cr-float-input')
      // 浮窗只投影最近几句：条数不变不代表没发出去，所以问宿主要 nextSeq 当判据。
      const floatSeq = () =>
        evaluate(
          cdp,
          imeSession,
          `(async () => {
            const response = await fetch('/api/dsh.chatroom/snapshot', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ type: 'client-request', rpcId: 'ime', method: 'dsh.chatroom/snapshot', payload: {} }),
            })
            const body = await response.json()
            const snapshot = body.result.value
            const rooms = snapshot.rooms
            const room = rooms.find((row) => row.id === snapshot.activeRoomId) || rooms[0]
            const box = document.querySelector('.cr-float-input')
            return {
              nextSeq: room ? room.nextSeq : null,
              room: room ? room.name : null,
              draft: box ? box.value : null,
            }
          })()`,
        )
      const floatBefore = await floatSeq()
      await evaluate(
        cdp,
        imeSession,
        `(() => {
          const box = document.querySelector('.cr-float-input')
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          box.focus()
          setter.call(box, '浮窗里拼音还没选完')
          box.dispatchEvent(new Event('input', { bubbles: true }))
          box.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true,
          }))
          return true
        })()`,
      )
      await sleep(400)
      const floatAfter = await floatSeq()
      if (floatAfter.nextSeq !== floatBefore.nextSeq) {
        throw new Error(
          `浮窗里拼字中的回车把话发出去了（${floatBefore.room}）：#${floatBefore.nextSeq} → #${floatAfter.nextSeq}`,
        )
      }
      if (!/浮窗里拼音还没选完/.test(String(floatAfter.draft))) {
        throw new Error(`浮窗里拼字中的回车把草稿吃掉了：${JSON.stringify(floatAfter.draft)}`)
      }
      await cdp.send('Target.closeTarget', { targetId: imeTarget })
      console.log('verified — 浮窗输入框：拼字中的回车不发送，草稿留着')

      const panelNow = () =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const box = document.querySelector('textarea.cr-textarea')
            return {
              rows: document.querySelectorAll('.cr-msg').length,
              draft: box ? box.value : null,
              error: document.querySelector('.cr-error-bar')
                ? String(document.querySelector('.cr-error-bar').textContent).trim()
                : null,
            }
          })()`,
        )
      const beforeIme = await panelNow()
      await evaluate(
        cdp,
        sessionId,
        `(() => {
          const box = document.querySelector('textarea.cr-textarea')
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          box.focus()
          setter.call(box, '这句是拼音拼到一半')
          box.dispatchEvent(new Event('input', { bubbles: true }))
          box.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true,
          }))
          return true
        })()`,
      )
      await sleep(450)
      const afterIme = await panelNow()
      if (afterIme.rows !== beforeIme.rows) {
        throw new Error(`面板里拼字中的回车把话发出去了：${beforeIme.rows} → ${afterIme.rows} 条`)
      }
      if (afterIme.draft !== '这句是拼音拼到一半') {
        throw new Error(`面板里拼字中的回车把草稿改了：${JSON.stringify(afterIme.draft)}`)
      }
      // 反证：选完词之后那一下回车必须照常发出去，别为了挡住拼字把发送也弄哑了。
      await evaluate(
        cdp,
        sessionId,
        `(() => {
          const box = document.querySelector('textarea.cr-textarea')
          box.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
          }))
          return true
        })()`,
      )
      let sent = null
      for (let i = 0; i < 40; i += 1) {
        sent = await panelNow()
        if (sent.rows > beforeIme.rows && sent.draft === '') break
        await sleep(100)
      }
      if (!(sent.rows > beforeIme.rows)) throw new Error('选完词（真正的回车）反而发不出去了')
      if (sent.draft !== '') throw new Error(`发送之后草稿没清空：${JSON.stringify(sent.draft)}`)
      if (sent.error) throw new Error(`这一下回车把界面弄报错了：${sent.error}`)
      console.log(
        `verified — 面板与浮窗都认输入法：拼字中的回车不发送、草稿留着；选完词的回车照常发（${beforeIme.rows} → ${sent.rows} 条）`,
      )
    }
    // 草稿是「这间屋子还没说出口的那句」：换屋子看一眼别的屋、回来还得在原处。
    // 以前只有一份全局草稿，换屋子会跟着搬过去 —— 人在 B 屋按一下回车，A 屋那句话
    // 就发进了 B 屋。这条同时验面板和浮窗：两边看的是同一间屋子，草稿也是同一份。
    // 不发送任何东西，只切屋子改草稿，所以不挑屏。
    if (wants(shot, 'draft-per-room')) {
      const readDraft = () =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const active = document.querySelector('.cr-room.cr-active')
            const box = document.querySelector('textarea.cr-textarea')
            const sendBtn = document.querySelector('.cr-input-row .cr-btn.cr-primary')
            const floatBox = document.querySelector('.cr-float-input')
            const errorBar = document.querySelector('.cr-error-bar')
            return {
              names: [...document.querySelectorAll('.cr-room .cr-room-name')].map((node) => String(node.textContent).trim()),
              active: active ? String(active.querySelector('.cr-room-name').textContent).trim() : null,
              draft: box ? box.value : null,
              composerOff: box ? box.disabled : null,
              sendOff: sendBtn ? sendBtn.disabled : null,
              floatDraft: floatBox ? floatBox.value : null,
              error: errorBar ? String(errorBar.textContent).trim() : null,
            }
          })()`,
        )
      const typeDraft = (selector, text) =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const box = document.querySelector(${JSON.stringify(selector)})
            if (!box) return false
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
            box.focus()
            setter.call(box, ${JSON.stringify(text)})
            box.dispatchEvent(new Event('input', { bubbles: true }))
            return true
          })()`,
        )
      const clickRoom = (name) =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const rows = [...document.querySelectorAll('.cr-room')]
            const row = rows.find((node) => String(node.querySelector('.cr-room-name').textContent).trim() === ${JSON.stringify(name)})
            if (!row) return false
            row.click()
            return true
          })()`,
        )
      const settle = async (check, note, tries = 60) => {
        for (let i = 0; i < tries; i += 1) {
          const done = await check()
          if (done) return
          await sleep(100)
        }
        throw new Error(note)
      }

      const start = await readDraft()
      if (!start || start.names.length < 2) {
        throw new Error(`这条要两间屋子才验得动：${JSON.stringify(start && start.names)}`)
      }
      if (start.error) throw new Error(`切屋子之前界面就报错了：${start.error}`)
      const mine = start.active
      if (!mine) throw new Error('找不到当前屋子')
      if (start.draft !== '') await typeDraft('textarea.cr-textarea', '')

      const mineDraft = '这半句是这间屋还没说出口的'
      await typeDraft('textarea.cr-textarea', mineDraft)
      await settle(async () => (await readDraft()).draft === mineDraft, '草稿没进输入框')

      // 换到另一间能说话的屋子：半句话不许跟过去，那里也没有东西可发。
      let other = null
      for (const name of start.names) {
        if (name === mine) continue
        if (!(await clickRoom(name))) continue
        await settle(async () => (await readDraft()).active === name, `点了「${name}」却没切过去`)
        const there = await readDraft()
        if (there.composerOff) continue
        if (there.draft !== '') {
          throw new Error(`换到「${name}」以后上一间屋的草稿跟过来了：${JSON.stringify(there.draft)}`)
        }
        if (there.sendOff !== true) {
          throw new Error(`换到「${name}」以后发送按钮还能按 —— 按下去就把「${mine}」那句话发进这间屋`)
        }
        other = name
        break
      }
      if (!other) throw new Error('没有第二间能说话的屋子，这条验不动')

      // 浮窗看的是同一间屋子，展开就该看到同一句话。
      await evaluate(cdp, sessionId, `document.querySelector('.cr-float-pill').click()`)
      await settle(async () => (await readDraft()).floatDraft !== null, '浮窗没展开')
      const otherRoom = await readDraft()
      if (otherRoom.floatDraft !== '') {
        throw new Error(`浮窗在「${other}」里还挂着上一间屋的草稿：${JSON.stringify(otherRoom.floatDraft)}`)
      }

      await clickRoom(mine)
      await settle(async () => (await readDraft()).active === mine, `点回「${mine}」却没切过去`)
      const back = await readDraft()
      if (back.draft !== mineDraft) throw new Error(`回「${mine}」以后面板草稿丢了：${JSON.stringify(back.draft)}`)
      if (back.floatDraft !== mineDraft) {
        throw new Error(`回「${mine}」以后浮窗没看到同一句话：${JSON.stringify(back.floatDraft)}`)
      }

      // 反过来：从浮窗里改草稿，面板跟着改（同一间屋子同一句话），换屋子以后两边都空。
      const fromFloat = '这一句是从浮窗里补的'
      await typeDraft('.cr-float-input', fromFloat)
      await settle(async () => (await readDraft()).draft === fromFloat, '浮窗里写的没同步到面板输入框')
      await clickRoom(other)
      await settle(async () => (await readDraft()).active === other, `再点「${other}」没切过去`)
      const crossed = await readDraft()
      if (crossed.draft !== '' || crossed.floatDraft !== '') {
        throw new Error(
          `从浮窗写的那句话跟着换屋子了：面板 ${JSON.stringify(crossed.draft)}、浮窗 ${JSON.stringify(crossed.floatDraft)}`,
        )
      }
      await clickRoom(mine)
      await settle(async () => (await readDraft()).active === mine, `点回「${mine}」却没切过去`)
      const restored = await readDraft()
      if (restored.draft !== fromFloat || restored.floatDraft !== fromFloat) {
        throw new Error(
          `来回切一遍草稿就丢了：面板 ${JSON.stringify(restored.draft)}、浮窗 ${JSON.stringify(restored.floatDraft)}`,
        )
      }
      await typeDraft('textarea.cr-textarea', '')
      await settle(async () => (await readDraft()).draft === '', '草稿清不掉')
      const cleaned = await readDraft()
      if (cleaned.error) throw new Error(`切屋子把界面弄报错了：${cleaned.error}`)
      console.log(
        `verified — 草稿跟着屋子走：换到「${other}」不带过去（发送按钮也按不了）、回「${mine}」还在；浮窗与面板共用同一份`,
      )
    }
    // @ 这条路：打一个 @ 就该开出候选、随打随筛，回车挑出来，正文里只有一个 @。
    // 以前候选只由「提及」按钮开关，挑一个候选是往草稿末尾拼「@名字 」——
    // 人已经打过的那个 @ 留在前面，发出去成了「@ @名字」；而候选开着时回车直接把
    // 「@账」当一句话发出去，看起来就像「不点那个按钮就 @ 不到人」。
    if (wants(shot, 'mention')) {
      const draftNow = () => evaluate(cdp, sessionId, `document.querySelector('textarea.cr-textarea').value`)
      const popRows = () =>
        evaluate(
          cdp,
          sessionId,
          `[...document.querySelectorAll('.cr-mention-pop .cr-pop-row')].map((node) => {
            // 名字有自己的类名：一行里还有头像（一只没有文字的鲸），
            // 按「第一个 span」取会拿到那个空元素。
            const span = node.querySelector('.cr-pop-name') ?? node.querySelector('span:last-child')
            return span ? String(span.textContent).trim() : String(node.textContent).trim()
          })`,
        )
      const typeAt = async (text) => {
        await cdp.send('Input.insertText', { text }, sessionId)
        await sleep(120)
      }
      // 真的按一下 @（Shift+2）：走的是人打字那条路，而不是直接把字符塞进去。
      const pressAt = async () => {
        await cdp.send(
          'Input.dispatchKeyEvent',
          {
            type: 'keyDown',
            modifiers: 8,
            key: '@',
            code: 'Digit2',
            text: '@',
            unmodifiedText: '@',
            windowsVirtualKeyCode: 50,
            nativeVirtualKeyCode: 50,
          },
          sessionId,
        )
        await cdp.send(
          'Input.dispatchKeyEvent',
          { type: 'keyUp', modifiers: 8, key: '@', code: 'Digit2', windowsVirtualKeyCode: 50, nativeVirtualKeyCode: 50 },
          sessionId,
        )
        await sleep(150)
      }
      const pressEnter = () =>
        cdp.send(
          'Input.dispatchKeyEvent',
          { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
          sessionId,
        )
      const until = async (check, note, tries = 80) => {
        for (let i = 0; i < tries; i += 1) {
          if (await check()) return
          await sleep(100)
        }
        throw new Error(note)
      }

      if ((await draftNow()) !== '') throw new Error('上一段检查没把草稿清干净，@ 这条验不动')
      await evaluate(cdp, sessionId, `document.querySelector('textarea.cr-textarea').focus()`)
      await pressAt()
      if ((await draftNow()) !== '@') throw new Error(`「@」没进输入框：${JSON.stringify(await draftNow())}`)

      let rows = []
      await until(
        async () => {
          rows = await popRows()
          return rows.length > 0
        },
        '打一个 @ 之后没有开出候选：人只能自己记得 agent 的名字',
      )
      const target = rows[0]
      // 用名字的第一个字当筛选词：候选要跟着变窄，而不是一直列着全部。
      const fragment = String(target).slice(0, 1)
      await typeAt(fragment)
      await until(
        async () => {
          rows = await popRows()
          return rows.length > 0 && rows.every((name) => name.indexOf(fragment) > -1)
        },
        `打了「${fragment}」之后候选没有跟着筛：${JSON.stringify(rows)}`,
      )
      if (rows.indexOf(target) === -1) {
        throw new Error(`筛完把要挑的那个弄丢了：想要「${target}」，剩 ${JSON.stringify(rows)}`)
      }

      const expectDraft = '@' + target + ' '
      await pressEnter()
      await sleep(200)
      const picked = await draftNow()
      if (picked !== expectDraft) {
        throw new Error(
          `回车挑候选之后草稿是 ${JSON.stringify(picked)}，应该是 ${JSON.stringify(expectDraft)}（多出来那个 @ 就是「两个 @@」的来源）`,
        )
      }

      // 真发出去：正文里只能有一个 @，而且那个 agent 要真的被叫起来回一句。
      const body = '这句是打出来的点名'
      await typeAt(body)
      await pressEnter()
      let sentRow = null
      await until(
        async () => {
          sentRow = await evaluate(
            cdp,
            sessionId,
            `(() => {
              const row = [...document.querySelectorAll('.cr-msg')]
                .find((node) => String(node.textContent).indexOf(${JSON.stringify(body)}) > -1)
              return row ? String(row.textContent) : null
            })()`,
          )
          return Boolean(sentRow)
        },
        '发出去之后在消息区找不到这一句',
      )
      if (/@@|@\s+@/.test(sentRow)) throw new Error(`正文里出现了两个 @：${JSON.stringify(sentRow)}`)
      if (sentRow.indexOf('@' + target) === -1) {
        throw new Error(`正文里没有「@${target}」：${JSON.stringify(sentRow)}`)
      }
      const hintText = () =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
            const node = [...document.querySelectorAll('.cr-hint')].find((row) => String(row.textContent).indexOf('没叫到') > -1)
            return node ? String(node.textContent).trim() : null
          })()`,
        )
      let answered = false
      await until(
        async () => {
          answered = await evaluate(
            cdp,
            sessionId,
            `(() => {
              const rows = [...document.querySelectorAll('.cr-msg')]
              const index = rows.findIndex((node) => String(node.textContent).indexOf(${JSON.stringify(body)}) > -1)
              return index > -1 && rows.slice(index + 1).some((node) => !node.classList.contains('cr-mine'))
            })()`,
          )
          return answered
        },
        '这句点名没人接：正文里写着 @ 名字，那个 agent 却没被叫起来',
      )
      // 有人接话了，「没叫到 agent」这句就得自己消失 —— 它还挂着就是在说反话。
      let staleHint = null
      await until(
        async () => {
          staleHint = await hintText()
          return !staleHint
        },
        `已经有人接了话，界面却还挂着「没叫到 agent」`,
        60,
      )
      console.log(
        `verified — 打 @ 就开候选（${target}）、随打随筛、回车挑出「${expectDraft}」；发出去的正文只有一个 @，那个 agent 真的接了话`,
      )
    }

    // 本机授权：卡片必须说清「谁、哪台机器、要哪个 agent 做什么」，两个按钮都得在，
    // 成员列底下的三档要停在「授权后执行」，并且这一屏真的挂着一条待授权（不是画上去的）。
    if (wants(shot, 'approve')) {
      const state = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const text = (node) => (node ? String(node.textContent).trim() : '')
          const card = document.querySelector('.cr-approve')
          const seg = [...document.querySelectorAll('.cr-auth-btn')].map((node) => ({
            label: text(node),
            on: node.getAttribute('aria-pressed') === 'true',
          }))
          if (!card) return { card: false, seg }
          const rect = card.getBoundingClientRect()
          return {
            card: true,
            title: text(card.querySelector('.cr-approve-eyebrow')),
            who: text(card.querySelector('.cr-approve-who')),
            meta: text(card.querySelector('.cr-approve-meta')),
            quote: text(card.querySelector('.cr-approve-quote')),
            body: text(card.querySelector('.cr-approve-body')),
            buttons: [...card.querySelectorAll('button')].map(text),
            countdown: text([...card.querySelectorAll('.cr-approve-count')].pop()),
            seg,
            note: text(document.querySelector('.cr-auth-note')),
            scope: text(document.querySelector('.cr-auth-scope')),
            inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight && rect.left >= 0 && rect.right <= window.innerWidth,
            wide: rect.width >= 380 && rect.width <= 520,
            rect: { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) },
            viewport: { width: window.innerWidth, height: window.innerHeight },
          }
        })()`,
      )
      if (!state.card) throw new Error('那一屏没有待授权卡片：这一轮根本没停下来等人')
      if (state.title !== '远程执行请求') throw new Error(`卡片标题不对：${JSON.stringify(state.title)}`)
      if (!/账期 agent/.test(state.who)) throw new Error(`卡片没说清要哪个 agent 跑：${JSON.stringify(state.who)}`)
      for (const expected of ['周荻的 MacBook', '周荻', 'Q4 复盘']) {
        if (!state.meta.includes(expected)) throw new Error(`卡片没说清「${expected}」：${JSON.stringify(state.meta)}`)
      }
      if (!/82 万/.test(state.quote)) throw new Error(`卡片没给出对方那句话：${JSON.stringify(state.quote)}`)
      if (!/现在轮到你了/.test(state.body)) throw new Error(`卡片没给出完整请求：${JSON.stringify(state.body.slice(0, 80))}`)
      if (state.buttons.join('|') !== '允许一次|拒绝') throw new Error(`按钮不对：${JSON.stringify(state.buttons)}`)
      if (state.countdown !== '90s') throw new Error(`倒计时没钉住：${JSON.stringify(state.countdown)}`)
      if (state.seg.map((row) => row.label).join('|') !== '只读|授权后执行|完全授权') {
        throw new Error(`三档没排出来：${JSON.stringify(state.seg)}`)
      }
      if (!state.seg[1].on || state.seg[0].on || state.seg[2].on) {
        throw new Error(`档位没停在「授权后执行」：${JSON.stringify(state.seg)}`)
      }
      if (!/问你一次/.test(state.note)) throw new Error(`底下的说明没解释这一档：${JSON.stringify(state.note)}`)
      if (state.scope !== '只影响这台机器') throw new Error(`没写清它只管这台机器：${JSON.stringify(state.scope)}`)
      if (!state.inViewport) throw new Error(`授权卡片跑到视口外了：人点不到 ${JSON.stringify(state.rect)} / ${JSON.stringify(state.viewport)}`)
      if (!state.wide) throw new Error(`授权卡片宽度不合适：${state.wide}`)
      console.log('verified — 授权窗口说清谁/哪台机器/要哪个 agent 做什么，两个按钮都在，成员列停在「授权后执行」；这一轮真挂在等人点')
      // 演完点「允许一次」把这一轮放过去：下一屏 gone 就在这间屋子拍，
      // 拒绝会在屋里留一条「没执行」的说明，那张图就不该带着它。
      await fetch(`http://127.0.0.1:${port}/preview/approve-done`)
    }

    await cdp.send('Target.closeTarget', { targetId })
  }

  cdp.close()
} finally {
  chrome.kill()
  if (emptyProc) emptyProc.kill()
}
