import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import {
  addMember,
  getMember,
  getRoom,
  markRead,
  membersOfPeer,
  postMessage,
  rememberSeat,
  removeMember,
  removePeer,
  seatOf,
} from './rooms.js'
import { ASSIGN_TIMEOUT, MAX_BODY, PEER_IDLE, WAIT_MS, fail, lanAddresses } from './lan.js'
import { pageMessages, project } from './project.js'
import { claimColor, isWhaleColor } from './palette.js'
import { code, codeStatus } from './code.js'

/**
 * LAN 宿主：这台机器上的房间让局域网里另一台机器加入。
 *
 * 它只解决一件事 —— **agent 不能跨机器执行**：
 * 宿主决定轮到某台机器上的 agent 时，不本地跑模型，而是把这一轮塞进
 * assignment 队列，对方长轮询领走、用它自己机器上的 session 跑完再回传。
 * 宿主校验「这条 assignment 是我的、还没被用掉」之后，才以那个成员的身份落库。
 *
 * 鉴权：房间码进 /lan/join，换到一个随机 peerId；之后每个请求都要带 peerId。
 * peerId 就是这台机器在这间屋子里的临时身份，宿主重启即失效（宁可让对面重连，
 * 也不要拿旧身份错认人）。明文 HTTP 是设计取舍，威胁模型是「同一 WiFi 下可信的人」。
 */

/**
 * 正文只认字符串。
 *
 * 不校验的话 `String({ a: 1 })` 会把 `[object Object]` 当成一句正常的聊天话落库 ——
 * 一次形状不对的请求就能在屋里留下一条谁也看不懂、却和真人说的一样的话，
 * 而且它还会被当成对话记录喂给模型。
 */
function textOf(value) {
  return typeof value === 'string' ? value : null
}

/** 等对面机器回一个回合的上限。测试用环境变量压短，量的是失败路径而不是耐心。 */
function assignTimeout() {
  const raw = Number(process.env.DSH_CHATROOM_ASSIGN_TIMEOUT)
  return Number.isSafeInteger(raw) && raw > 0 ? raw : ASSIGN_TIMEOUT
}

/**
 * 对面的机器多久没露面就算走了。默认 45s 比一次长轮询（25s）长一倍，
 * 刚好处在「轮询间隙」和「真的关掉了」之间；用环境变量压短给测试走失败路径。
 */
function peerIdle() {
  const raw = Number(process.env.DSH_CHATROOM_PEER_IDLE)
  return Number.isSafeInteger(raw) && raw > 0 ? raw : PEER_IDLE
}

/** 清扫周期：比 idle 短，掉线后最多一个周期就能从成员列里消失。 */
function sweepMs() {
  return Math.min(15_000, Math.max(500, Math.floor(peerIdle() / 3)))
}

const logDefault = () => {}

/** 端口 0 是有意义的（让系统挑一个空闲端口，测试与截图走这条），所以不能写成 `|| 4399`。 */
function defaultPort() {
  const raw = process.env.DSH_CHATROOM_PORT
  if (raw === undefined || raw === '') return 4399
  const port = Number(raw)
  return Number.isSafeInteger(port) && port >= 0 ? port : 4399
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      reject(Object.assign(new Error('请求体太大'), { code: 'too_large' }))
      return
    }
    const chunks = []
    let bytes = 0
    request.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BODY) {
        reject(Object.assign(new Error('请求体太大'), { code: 'too_large' }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(Object.assign(new Error('请求体不是 JSON'), { code: 'bad_json' }))
      }
    })
    request.on('error', reject)
  })
}

const ipOf = (request) => String(request.socket.remoteAddress ?? '').replace(/^::ffff:/, '')

/**
 * 对面把连接断了（关窗口、进程被杀）时，长轮询要立刻醒。
 *
 * 不醒的话，服务器会继续把手上的等待跑满 25 秒才释放 —— 期间那台机器仍被当成
 * 「正在轮询、还活着」，清扫器不敢清，成员列里就是一条挂着的幽灵。
 */
function closedSignal(request, response) {
  return new Promise((resolve) => {
    const done = () => resolve('closed')
    if (request.destroyed || response.destroyed) done()
    else {
      request.once('close', done)
      response.once('close', done)
    }
  })
}

export function createLanHost({ store, onHumanMessage = () => {}, log = logDefault, machine = hostname(), port } = {}) {
  /** peerId → {id, machine, address, roomId, selfMemberId, since, lastSeen, agents} */
  const peers = new Map()
  /** assignmentId → {id, peerId, roomId, memberId, agentId, memberName, prompt, ...} */
  const assignments = new Map()
  /** 长轮询的唤醒器：有人加入、有新 assignment、状态变了，都推一下。 */
  const wakers = new Set()
  let server = null
  let sweeper = null
  let bound = { port: null }
  let closed = false
  let lastError = null

  const wake = () => {
    for (const fn of [...wakers]) {
      try {
        fn()
      } catch {
        /* 唤醒器自己的错误不该影响别人 */
      }
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        wakers.delete(finish)
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, ms)
      timer.unref?.()
      wakers.add(finish)
    })
  }

  function waitRevision(since, ms) {
    if (store.state.revision !== since) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        wakers.delete(finish)
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
      const timer = setTimeout(finish, ms)
      timer.unref?.()
      const unsubscribe = store.subscribe(finish)
      wakers.add(finish)
    })
  }

  /**
   * 这台机器是不是还活着。
   *
   * 光看 lastSeen 不够，有两种「沉默但活着」：
   *   - 正在跑模型：那台机器几十秒不轮询，按时间判会把一个正在写回复的 agent 当成掉线；
   *   - 长轮询还挂着：这 25 秒里它一个请求都还没发出下一句。
   * 这两种都算活着；只有连接断了、又过了 idle 之后才清。
   */
  function busy(peerId) {
    for (const row of assignments.values()) {
      if (!row.done && row.peerId === peerId) return true
    }
    return false
  }

  const alive = (peer, now = Date.now()) =>
    (peer.inflight ?? 0) > 0 || busy(peer.id) || now - peer.lastSeen < peerIdle()

  function status() {
    const now = Date.now()
    return {
      serving: Boolean(server && bound.port),
      port: bound.port,
      /** 跑着的这份代码是哪一版、什么时候进的进程：热重载/重启后与原值可比。 */
      code,
      machine,
      addresses: lanAddresses(),
      error: lastError,
      pending: [...assignments.values()].filter((row) => !row.done).length,
      peers: [...peers.values()]
        .filter((peer) => alive(peer, now))
        .map((peer) => ({
          id: peer.id,
          machine: peer.machine,
          address: peer.address,
          roomId: peer.roomId,
          agents: peer.agents.map((agent) => agent.name),
          /**
           * 这台机器报过来说「我能补报 agent」吗。
           *
           * 它进来时一个 agent 都没带，有两种完全不同的原因：本机真的还没建
           * （人该去那台机器的左栏建一个），或者那台的插件是旧版本、根本没有补报这条路
           * （人该重启那台的桌面端）。少了这个能力位，界面只能沉默。
           */
          canAgents: Boolean(peer.canAgents),
          since: peer.since,
          lastSeen: peer.lastSeen,
        })),
    }
  }

  function requirePeer(peerId) {
    const peer = peers.get(String(peerId ?? ''))
    if (!peer) fail('peer_unknown', '这台机器的加入凭据已失效，请重新加入房间。')
    peer.lastSeen = Date.now()
    return peer
  }

  /**
   * 某台机器上报的 agent → 屋里的成员 id。
   *
   * 带上 peer 片段：两台机器如果装的是同一份配置（bot id 相同），只按 botId 拼 id
   * 会让第二个人顶掉第一个人的成员，话就算到别人头上。
   */
  function agentMemberId(peer, key) {
    return `m_${peer.id.slice(2, 10)}_${key}`
  }

  /**
   * 把「这台机器现在带着哪些 agent」对账成屋里的成员：缺的补、改的更新、撤掉的移除。
   *
   * 为什么需要这一步而不是只在加入时报一次：新装的机器上一个 agent 都没有，
   * 人往往是**先挤进屋、才想起要带谁**。只认加入那一刻的名单，屋里就永远只有他一个人。
   *
   * seat 是这条 link 上次离开时记下的席位：它带的 agent 成员 id 直接沿用，
   * 否则重启回来它自己的 agent 会变成「另一个 agent」，过去说的话也就不属于它了。
   */
  function reconcileAgents(draft, peer, agents, origin, seat = null) {
    const room = getRoom(draft, peer.roomId)
    if (!room) fail('room_not_found', '这间屋子已经不在了。')
    const declared = (Array.isArray(agents) ? agents : [])
      .slice(0, 12)
      .map((agent) => ({
        key: (textOf(agent?.id) ?? '').trim().slice(0, 64),
        name: (textOf(agent?.name) ?? '').trim().slice(0, 60),
        role: (textOf(agent?.role) ?? '').trim().slice(0, 200),
      }))
      .filter((agent) => agent.key)
    const seen = new Set(declared.map((agent) => agent.key))
    let added = 0
    let updated = 0
    const nextAgents = []
    for (const agent of declared) {
      const existing = room.members.find(
        (member) => member.owner === peer.id && member.kind === 'bot' && member.botId === agent.key,
      )
      if (existing) {
        // 颜色是这间屋里的座位：agent 不随身带颜色，屋里空着哪一档就用哪一档；
        // 已经有座位的那只保持原样，别每次重连换一次颜色。
        if (agent.name && existing.name !== agent.name) {
          existing.name = agent.name
          updated += 1
        }
        if (existing.role !== agent.role) {
          existing.role = agent.role
          updated += 1
        }
        const nextColor = claimColor(room, { current: existing.color ?? null, exceptId: existing.id })
        if (nextColor && existing.color !== nextColor) {
          existing.color = nextColor
          updated += 1
        }
        nextAgents.push({ memberId: existing.id, agentId: agent.key, name: existing.name })
        continue
      }
      const reused = seat?.agents?.[agent.key]
      const id =
        reused && !room.members.some((member) => member.id === reused) ? reused : agentMemberId(peer, agent.key)
      const row = addMember(draft, {
        roomId: room.id,
        member: {
          id,
          kind: 'bot',
          name: agent.name || 'agent',
          role: agent.role,
          botId: agent.key,
          sessionId: null,
          origin,
          owner: peer.id,
          reach: 'lan',
          seat: peer.instance ?? null,
        },
      })
      nextAgents.push({ memberId: row.id, agentId: agent.key, name: row.name })
      added += 1
    }
    // 那台机器上已经删掉/换掉的 agent：成员也撤，别留一个永远不回话的幽灵。
    let removed = 0
    for (const member of room.members.filter((row) => row.owner === peer.id && row.kind === 'bot')) {
      if (seen.has(member.botId)) continue
      removeMember(draft, { roomId: room.id, memberId: member.id })
      removed += 1
    }
    peer.agents = nextAgents
    return { added, updated, removed }
  }

  /** 加入之后补报名单走这里：对账 + 把新投影回给那台机器。 */
  function syncAgents(peer, agents) {
    // 能走到这个端点本身就是证明：这台机器有补报的路（能力位在旧版加入方那边永远是空的）。
    peer.canAgents = true
    peer.lastSeen = Date.now()
    let stat = { added: 0, updated: 0, removed: 0 }
    store.commit((draft) => {
      stat = reconcileAgents(draft, peer, agents, { kind: 'lan', peer: peer.address, machine: peer.machine })
    })
    if (stat.added || stat.updated || stat.removed) wake()
    return { ...stat, snapshot: viewFor(peer) }
  }

  /**
   * 房间码试错的节流。
   *
   * 房间码是六位 32 进制（≈1.07×10^9），靠猜本来就没什么希望；但没有节流时，同网段
   * 一台机器可以对着 4399 打满速请求一直猜，这件事没有成本。这里按**来源地址**记最近
   * 一分钟里失败了几次，到上限就 429，并告诉人还要等几秒。
   *
   * 只记失败的加入（房间码为空、没有这间屋、那是镜像屋）；成功加入会把这一格清掉。
   * 按地址分格而不是全局计数：一个人打错十几次，不该把同屋别人挡在外面。计数只在
   * 内存里，宿主重启就归零 —— 它挡的是「一直猜」，不是给房间码加第二把锁。
   */
  const JOIN_WINDOW_MS = 60_000
  const JOIN_LIMIT = 12
  const joinFails = new Map()

  function joinWithThrottle(input, address) {
    const now = Date.now()
    const key = String(address || 'unknown')
    const recent = (joinFails.get(key) ?? []).filter((at) => now - at < JOIN_WINDOW_MS)
    if (recent.length >= JOIN_LIMIT) {
      const wait = Math.max(1, Math.ceil((JOIN_WINDOW_MS - (now - recent[0])) / 1000))
      fail('too_many_tries', `房间码试错太频繁了，等 ${wait} 秒再试。`)
    }
    try {
      const value = joinRoom(input, address)
      joinFails.delete(key)
      return value
    } catch (error) {
      recent.push(now)
      joinFails.set(key, recent)
      throw error
    }
  }

  function joinRoom({ code, machine: guestMachine, self, agents, build, instance: rawInstance }, address) {
    if (typeof code !== 'string') fail('code_required', '房间码不能为空。')
    const wanted = code.trim().toUpperCase()
    if (!wanted) fail('code_required', '房间码不能为空。')
    const room = store.state.rooms.find((row) => String(row.code ?? '').toUpperCase() === wanted)
    if (!room) fail('room_not_found', '房间码不对，或这台机器上没有这间屋子。')
    if (room.remote) fail('remote_room', '这是从别的机器同步过来的房间，不能在这里再当宿主。')

    /**
     * 同一条 link 回来了（桌面端重启、插件重载）：上一代那一组不是「另一个人」，
     * 是**同一个人换了个 peerId**，所以成员要整组接过来，而不是撤掉再建一套。
     *
     * 加入方的 link 是落盘的，重启之后拿同一个 id 重新握手。不认它的话，屋里会多出
     * 一组「另一个他」，旧那组要等 peerIdle（45s）才被扫掉；而这段时间里 @ 到旧的
     * 那个必然超时（那台机器已经不在了），自己过去说的话也不再属于自己。
     *
     * 接过成员 id 还有两个想要的副作用：已读游标连着（不会把整段历史重新标成未读），
     * 历史消息的 authorId 也对得上（重启不会把自己说过的话变成别人说的）。
     *
     * 上一代 peer 已经不在 map 里了（宿主自己重启过，或者断线超过清扫时间），
     * 就退回席位表：那条 link 上次离开时留下的成员 id 还在，接上去还是同一个人。
     */
    const instance = String(rawInstance ?? '').trim().slice(0, 64)
    const seat = seatOf(room, instance)
    const adopted = []
    if (instance) {
      for (const other of [...peers.values()]) {
        if (other.roomId !== room.id || other.instance !== instance) continue
        peers.delete(other.id)
        adopted.push(other)
      }
    }

    const peerId = `p_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    /**
     * 重启那一刻正交在它手上的那一轮，也要换主人。
     *
     * 远程 agent 的回合是「那台机器用自己本地 session 跑、跑完回传」：重启把那次运行
     * 打断了，但宿主这边的派发还挂在旧的 peerId 上。不接过来的话，人明明已经回来了，
     * 这一轮却只能在超时后落一条「对面机器没有回应」——看起来像它没理人。
     */
    const carried = [...assignments.values()].filter(
      (row) => !row.done && adopted.some((other) => other.id === row.peerId),
    )
    const label = String(guestMachine ?? '').trim().slice(0, 64) || address
    const peer = {
      id: peerId,
      machine: label,
      address,
      roomId: room.id,
      selfMemberId: null,
      since: Date.now(),
      lastSeen: Date.now(),
      agents: [],
      instance: instance || null,
      // 旧版加入方不会带这个字段：屋里只有他一个人时，界面要能分清是他还没建 agent
      // 还是那台根本报不了。Number(undefined) 是 NaN，比较结果为 false，正好落在「报不了」。
      canAgents: Number(build?.agents) >= 1,
    }
    const origin = { kind: 'lan', peer: address, machine: label }
    // 对面没报名字（或跟本机同名）时用机器名兜底：屋里出现两个「我」，
    // 成员列和 @ 都会认错人。
    const declaredName = (textOf(self?.name) ?? '').trim().slice(0, 60)
    const humanName = !declaredName || declaredName === store.state.self.name ? label : declaredName
    // 他挑的那一档。旧版加入方不带这个字段 —— 那就给一档屋里空着的，不是「没有颜色」。
    // colorPicked 只在对面**加入表单里真选了颜色**时为 true：点过的那一档被同屋别人占着
    // 就报 color_taken；没点过（自动重连报「上次坐的那一档」）则能留就留、被占就换一档空的。
    const wantedColor = isWhaleColor(self?.color) ? self.color : null
    const existingHuman =
      room.members.find((member) => member.kind === 'human' && instance && member.seat === instance) ??
      room.members.find(
        (member) => member.kind === 'human' && adopted.some((other) => other.id === member.owner),
      ) ??
      null
    // 颜色在 commit 之前定好：被同屋别人占了要报 color_taken，而 commit 里抛异常时
    // 前面改过的 owner / 名字已经写进 state 了（revision 不涨，字段却变了），
    // 会留下一半接管。先算，再写。
    const claimedColor = claimColor(room, {
      wanted: wantedColor,
      current: existingHuman?.color ?? null,
      exceptId: existingHuman?.id ?? null,
      strict: self?.colorPicked === true && Boolean(wantedColor),
    })

    store.commit((draft) => {
      if (adopted.length) {
        const next = getRoom(draft, room.id)
        for (const other of adopted) {
          for (const member of next.members) {
            if (member.owner !== other.id) continue
            member.owner = peerId
            // 机器名/地址跟着换：重装、改机器名之后回来，成员列上不该还是旧那台。
            member.origin = origin
          }
        }
        log('lan_peer_takeover', {
          machine: label,
          address,
          from: adopted.map((other) => other.machine),
          carried: carried.length,
        })
      }
      // 接过来的那个人还是同一个人：名字以这次上报为准，成员 id 不动。
      // 上一代 peer 已经不在时（宿主重启过 / 被清扫过），就照席位表里记的那个 id 重新落座 ——
      // 席位是有意的「记下 id 等它回来」，不是「找到还在的成员」。
      const live = getRoom(draft, room.id).members
      const known =
        live.find((member) => member.owner === peerId && member.kind === 'human') ??
        (seat?.human ? live.find((member) => member.id === seat.human && member.kind === 'human') : null) ??
        null
      const human =
        known ??
        addMember(draft, {
          roomId: room.id,
          member: {
            id: seat?.human ?? `h_${peerId.slice(2, 12)}`,
            kind: 'human',
            name: humanName,
            role: '',
            color: claimedColor,
            origin,
            owner: peerId,
            reach: 'lan',
            seat: instance || null,
          },
        })
      // 席位落座的这一组：owner 换成新的 peerId，席位标记照旧（它靠 instance 认人）。
      human.owner = peerId
      human.seat = instance || human.seat || null
      if (human.name !== humanName) human.name = humanName
      // 颜色同样以这一次上报为准：接回座位的这个人可能在加入表单里换了一档。
      if (human.color !== claimedColor) human.color = claimedColor
      peer.selfMemberId = human.id
      // 加入那一刻报上来的 agent 名单走同一套对账，和「加入之后补报」共用一条路。
      reconcileAgents(draft, peer, agents, origin, seat)
      // 人暂时不在时被让空的椅子，等人回来还给他。
      const after = getRoom(draft, room.id)
      if (seat?.chair && after.rules.chairId === null && after.members.some((member) => member.id === seat.chair)) {
        after.rules.chairId = seat.chair
      }
      // 席位随时对齐到这一代真实的成员 id：名字/agent 名单都可能变，接回去的必须是现在这组。
      if (instance) {
        const mine = membersOfPeer(after, peerId)
        const agentsByName = {}
        for (const member of mine) if (member.kind === 'bot' && member.botId) agentsByName[member.botId] = member.id
        rememberSeat(after, instance, {
          human: human.id,
          agents: agentsByName,
          chair: mine.some((member) => member.id === after.rules.chairId) ? after.rules.chairId : null,
          machine: label,
        })
      }
    })

    peers.set(peerId, peer)
    // 换主人 + 重新计时：上一代剩下的等待窗口不该克扣新这一代的这一轮。
    for (const row of carried) {
      row.peerId = peerId
      // 上一代可能已经把这条领走了（回合跑到一半才重启），新的一代要能重新领。
      row.claimedAt = null
      arm(row)
    }
    wake()
    return {
      peerId,
      roomId: room.id,
      selfMemberId: peer.selfMemberId,
      hostMachine: machine,
      snapshot: project(store.state, { lan: status(), viewerId: peer.selfMemberId }),
    }
  }

  /**
   * 给一条派发计时：到点还没人回，就落失败占位，不让整轮卡死。
   *
   * 单独摘出来是因为它可能被重新计一次时（见 joinRoom 里「在路上的一轮」）：
   * 那台机器重启回来了，这一轮要按新的等待窗口重新算，不能沿用上一代剩下的那几秒。
   *
   * 另外，对面如果开着「授权后执行」，它要等本机的人点按钮 —— 那段时间不是它的错。
   * 它会在等之前先敲 /lan/hold 把这条的期限往后延（extendAssignment）。
   */
  function arm(row) {
    clearTimeout(row.timer)
    const left = Math.max(0, row.deadline - Date.now())
    row.timer = setTimeout(() => {
      if (row.done) return
      row.done = true
      assignments.delete(row.id)
      wake()
      row.reject(Object.assign(new Error('对面机器没有回应。'), { code: 'lan_timeout' }))
    }, left)
    row.timer.unref?.()
  }

  /** 一条派发的总期限上限：再多的延长也不能把「一轮」拖成没有尽头。 */
  const MAX_ASSIGN_WAIT = 300_000
  const MAX_HOLD = 180_000

  /**
   * 对面在等人点授权，请求把这条派发的等待往后延。
   *
   * 不延的话，默认 45 秒的等待窗口会先到：人还在犹豫，这边已经落了一条「没回上来」，
   * 之后对面就算被允许，回传也只会撞上 assignment_expired。
   */
  function extendAssignment(row, ms) {
    const add = Math.max(0, Math.min(MAX_HOLD, Number(ms) || 0))
    const cap = row.createdAt + MAX_ASSIGN_WAIT
    row.deadline = Math.min(cap, Math.max(row.deadline, Date.now()) + add)
    arm(row)
    return { extended: row.deadline - Date.now() }
  }

  /**
   * 把一个 agent 回合派发给它所在的机器。
   * 45s 没回音就落一条失败占位（speak.js 负责写），不让整轮卡死。
   */
  function enqueue({ roomId, member, prompt, facts = null, from = null }) {
    if (!member?.owner || member.owner === 'local') {
      return Promise.reject(Object.assign(new Error('not_remote'), { code: 'not_remote' }))
    }
    const peer = peers.get(member.owner)
    if (!peer || !alive(peer)) {
      return Promise.reject(Object.assign(new Error(`${member.name} 所在的机器不在线。`), { code: 'peer_offline' }))
    }
    const id = `as_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    return new Promise((resolve, reject) => {
      const row = {
        id,
        peerId: member.owner,
        roomId,
        memberId: member.id,
        agentId: member.botId,
        memberName: member.name,
        prompt,
      facts,
        // 引发出这一轮的是谁：对面机器要在授权窗口里说清「谁要它做什么」。
        // 本机的人引出来的（from.machine 为空）就填本机名 —— 对那台机器来说，
        // 请求确实来自这台机器。
        from: from
          ? {
              name: String(from.name ?? '').slice(0, 60),
              machine: String(from.machine || machine).slice(0, 60),
              kind: from.kind === 'bot' ? 'bot' : 'human',
              // 引出这一轮的原话：对面那台机器的授权窗口要让人看懂「为什么要它做」。
              text: String(from.text ?? '').slice(0, 400),
            }
          : null,
        createdAt: Date.now(),
        deadline: Date.now() + assignTimeout(),
        claimedAt: null,
        done: false,
        resolve,
        reject,
      }
      arm(row)
      assignments.set(id, row)
      wake()
    })
  }

  async function nextAssignment(peerId) {
    const deadline = Date.now() + WAIT_MS
    for (;;) {
      const row = [...assignments.values()].find((item) => !item.done && !item.claimedAt && item.peerId === peerId)
      if (row) {
        row.claimedAt = Date.now()
        return {
          id: row.id,
          roomId: row.roomId,
          memberId: row.memberId,
          agentId: row.agentId,
          memberName: row.memberName,
          prompt: row.prompt,
        facts: row.facts ?? null,
          from: row.from,
        }
      }
      const left = deadline - Date.now()
      if (left <= 0) return null
      await sleep(left)
    }
  }

  function settleAssignment({ peerId, assignmentId, text, error, denied }) {
    const row = assignments.get(String(assignmentId ?? ''))
    if (!row || row.done) fail('assignment_expired', '这一轮已经结束了。')
    if (row.peerId !== peerId) fail('assignment_denied', '这条派发不属于这台机器。')
    row.done = true
    clearTimeout(row.timer)
    assignments.delete(row.id)
    wake()
    if (denied) {
      // 对面那台机器的本机授权没过：这不是失败，是它的人/设置做的选择。
      // 单独一个 code，让宿主落一条说明而不是红色失败占位（重试也还是不会过）。
      row.reject(Object.assign(new Error('declined'), { code: 'declined', reason: String(denied).slice(0, 32) }))
    } else if (error) {
      row.reject(Object.assign(new Error(String(error).slice(0, 200) || '对面没能回上来'), { code: 'lan_failed' }))
    } else {
      row.resolve({ text: String(text ?? '') })
    }
    return { ok: true }
  }

  function viewFor(peer) {
    return project(store.state, { lan: status(), viewerId: peer.selfMemberId })
  }

  /**
   * 解析请求地址。
   *
   * 不能用请求头里的 Host 当 base —— `Host: [`、带空格的 Host、`GET http://[` 这类
   * 畸形请求会让 new URL 直接抛 ERR_INVALID_URL，而这是**局域网里任何人**都能发的包。
   * origin-form 的请求（我们只认这种）根本不需要 Host，所以 base 写死就行。
   */
  function targetOf(request) {
    try {
      return new URL(String(request.url ?? '/'), 'http://lan.local')
    } catch {
      return null
    }
  }

  function reject400(response, code, message) {
    if (response.destroyed || response.writableEnded) return
    response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: false, error: { code, message } }))
  }

  async function route(request, response) {
    const url = targetOf(request)
    if (!url) {
      reject400(response, 'bad_request', '这个请求的地址没法解析。')
      return
    }
    const path = url.pathname.replace(/\/+$/, '') || '/'
    let value
    try {
      if (closed) fail('disabled', '这只宿主已经停了。')

      if (path === '/lan/join' && request.method === 'POST') {
        value = joinWithThrottle(await readJson(request), ipOf(request))
      } else if (path === '/lan/state' && request.method === 'GET') {
        const peer = requirePeer(url.searchParams.get('peerId'))
        const since = Number(url.searchParams.get('since') ?? -1)
        peer.inflight = (peer.inflight ?? 0) + 1
        let why = 'value'
        try {
          why = await Promise.race([waitRevision(since, WAIT_MS).then(() => 'value'), closedSignal(request, response)])
        } finally {
          peer.inflight -= 1
        }
        // 连接已经断了就别再记成「刚露过面」，否则死后还能靠一次握手把清扫推迟一轮。
        if (why !== 'closed') peer.lastSeen = Date.now()
        value = { revision: store.state.revision, snapshot: viewFor(peer), hostMachine: machine, selfMemberId: peer.selfMemberId }
      } else if (path === '/lan/message' && request.method === 'POST') {
        const input = await readJson(request)
        const peer = requirePeer(input.peerId)
        const room = getRoom(store.state, peer.roomId)
        if (!room) fail('room_not_found', '这间屋子已经不在了。')
        const text = textOf(input.text)
        if (text === null) fail('bad_text', '正文只能是字符串。')
        // 默认以「那台机器上的人」署名；带了 authorBotId 就用它名下报备过的 agent。
        // 只在这一条连接自己的成员里找 —— 别的机器的 agent 一个都点不到，冒不了名。
        const authorBotId = typeof input.authorBotId === 'string' ? input.authorBotId.trim().slice(0, 64) : ''
        let authorId = peer.selfMemberId
        if (authorBotId) {
          const agent = room.members.find(
            (member) => member.owner === peer.id && member.kind === 'bot' && member.botId === authorBotId,
          )
          if (!agent) fail('unknown_agent', '这台机器报的 agent 不在这间屋里，拒绝冒名。')
          authorId = agent.id
        }
        let posted = null
        store.commit((draft) => {
          posted = postMessage(draft, {
            roomId: peer.roomId,
            authorId,
            text,
            mentions: input.mentions,
            replyTo: input.replyTo,
            origin: { kind: 'lan', peer: peer.address, machine: peer.machine },
            opKey: input.opKey,
          })
        })
        // silent：只落库、不触发任何回合（完成通知走这条）。
        if (posted && input.silent !== true) onHumanMessage({ roomId: peer.roomId, messageId: posted.id })
        value = { messageId: posted?.id ?? null, seq: posted?.seq ?? null, snapshot: viewFor(peer) }
      } else if (path === '/lan/assignments' && request.method === 'GET') {
        const peer = requirePeer(url.searchParams.get('peerId'))
        peer.inflight = (peer.inflight ?? 0) + 1
        let picked = null
        let why = 'value'
        try {
          why = await Promise.race([
            nextAssignment(peer.id).then((assignment) => {
              picked = assignment
              return 'value'
            }),
            closedSignal(request, response),
          ])
        } finally {
          peer.inflight -= 1
        }
        if (why !== 'closed') peer.lastSeen = Date.now()
        value = { assignment: picked, revision: store.state.revision }
      } else if (path === '/lan/reply' && request.method === 'POST') {
        const input = await readJson(request)
        const peer = requirePeer(input.peerId)
        const denied = typeof input.denied === 'string' ? input.denied : ''
        if (!denied && input.error === undefined && textOf(input.text) === null) {
          fail('bad_text', '回传的正文只能是字符串。')
        }
        value = settleAssignment({
          peerId: peer.id,
          assignmentId: input.assignmentId,
          text: input.text,
          error: input.error,
          denied,
        })
      } else if (path === '/lan/hold' && request.method === 'POST') {
        /**
         * 对面在等人点授权：把这条派发的期限往后延。
         *
         * 它认得自己的 assignment（peerId + assignmentId 都要对上），所以这条路由不会
         * 变成「谁都能占住一台机器的一轮」的入口。
         */
        const input = await readJson(request)
        const peer = requirePeer(input.peerId)
        const row = assignments.get(String(input.assignmentId ?? ''))
        if (!row || row.done) fail('assignment_expired', '这一轮已经结束了。')
        if (row.peerId !== peer.id) fail('assignment_denied', '这条派发不属于这台机器。')
        value = extendAssignment(row, input.ms)
      } else if (path === '/lan/messages' && request.method === 'POST') {
        /**
         * 加入方往回翻历史。
         *
         * 房间只从凭据里认（peer.roomId），不看请求里说的 roomId —— 一张 peerId
         * 只能翻到自己已经加入的那间屋子，不能借一条合法凭据去读别人的历史。
         */
        const input = await readJson(request)
        const peer = requirePeer(input.peerId)
        const room = getRoom(store.state, peer.roomId)
        if (!room) fail('room_not_found', '这间屋子已经不在了。')
        value = pageMessages(room, { beforeSeq: input.beforeSeq, limit: input.limit })
      } else if (path === '/lan/read' && request.method === 'POST') {
        const input = await readJson(request)
        const peer = requirePeer(input.peerId)
        store.commit((draft) => {
          markRead(draft, { roomId: peer.roomId, memberId: peer.selfMemberId, seq: Number(input.seq) })
        })
        // 顺手把已读后的投影带回去：否则加入方本地先清零，又会被一条在途的
        // 长轮询旧快照覆盖回去，界面上未读数会「闪回来」。
        value = { snapshot: viewFor(peer) }
      } else if (path === '/lan/self' && request.method === 'POST') {
        const input = await readJson(request)
        const peer = requirePeer(input.peerId)
        const name = textOf(input.name)
        const color = isWhaleColor(input.color) ? input.color : null
        // 只换色、不改名也是合法的一次上报（点色块时就这样发）；两样都没有才是坏包。
        if (name === null && !color) fail('bad_text', '名字只能是字符串。')
        const trimmed = (name ?? '').trim().slice(0, 60)
        // 颜色是这间屋里的座位：被同屋别人占着就回 color_taken，让他自己换一档。
        // 跟加入时一样，先算再写：commit 里抛异常会留下「名字改了、颜色没改」的半截。
        const roomNow = getRoom(store.state, peer.roomId)
        if (!roomNow) fail('room_not_found', '这间屋子已经不在了。')
        const memberNow = getMember(roomNow, peer.selfMemberId)
        const nextColor = color
          ? claimColor(roomNow, {
              wanted: color,
              current: memberNow?.color ?? null,
              exceptId: memberNow?.id ?? null,
              strict: true,
            })
          : null
        if (trimmed || nextColor) {
          store.commit((draft) => {
            const room = getRoom(draft, peer.roomId)
            const member = room ? getMember(room, peer.selfMemberId) : null
            if (!member) return
            if (trimmed) member.name = trimmed
            if (nextColor) member.color = nextColor
          })
        }
        // 带上新投影：加入方点一下色块要立刻看到自己换了色，不能等下一轮长轮询回来
        // （那期间两边各显示一个颜色，比点不动更像坏了）。
        value = { renamed: Boolean(trimmed), colored: Boolean(nextColor), snapshot: viewFor(peer) }
      } else if (path === '/lan/agents' && request.method === 'POST') {
        /**
         * 那台机器补报名单：它刚建了一个 agent，或者改了名字/职责、删掉了一个。
         * 宿主在这里对账，改名不动历史（消息里记的是当时的署名）。
         */
        const input = await readJson(request)
        const peer = requirePeer(input.peerId)
        value = syncAgents(peer, input.agents)
      } else if (path === '/lan/leave' && request.method === 'POST') {
        const input = await readJson(request)
        const peer = requirePeer(input.peerId)
        peers.delete(peer.id)
        store.commit((draft) => {
          // 主动离开：席位一并忘掉。人已经明确退出这间屋，下次进来该是新客。
          removePeer(draft, { roomId: peer.roomId, peerId: peer.id, keepSeat: false })
        })
        wake()
        value = { left: true }
      } else if (path === '/lan/ping') {
        /**
         * 不需要凭据的那个探针，顺手带上版本与装载时间。
         *
         * 排障时最常问的一句是「对面跑的是哪一版、还是我们刚改的那份吗」，而这份信息
         * 恰恰只有**跑着的那台机器**知道。机器的名字本来就已经在这里报出去了，版本
         * 比它还不敏感，所以放这儿不额外扩大暴露面。
         */
        // 探针要答的是「我磁盘上这份改了、跑着的进程换了没有」：每次都重新看磁盘，
        // 不能拿装载那一刻的快照 —— 那样改完之后它永远说没变。
        value = { ok: true, hostMachine: machine, serving: Boolean(bound.port), code: codeStatus() }
      } else {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: '没有这个端点。' } }))
        return
      }
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'internal_error'
      const status = code === 'peer_unknown' || code === 'room_not_found' || code === 'code_required' ? 403 : code === 'too_many_tries' ? 429 : 400
      if (response.destroyed || response.writableEnded) return
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: { code, message: String(error?.message ?? code).slice(0, 300) } }))
      return
    }
    if (response.destroyed || response.writableEnded) return
    /**
     * 这里**不发** Access-Control-Allow-Origin。
     *
     * 局域网面的调用方只有两种：另一台机器上的插件进程（node 的 fetch，不看 CORS），
     * 和排障时手敲的 curl。浏览器从来不走这条路 —— 界面那半边调的是宿主的
     * RPC（`/api/dsh.chatroom/*`，同源、宿主认证）。所以放行头没有任何用处，只多出
     * 一条「随便哪个网页都能读过本机聊天记录」的路：带着 Origin 的 GET 是简单请求，
     * 不被放行头挡住时浏览器会把屋里的话、成员的机器名、刚拿到的 peerId 都交给它。
     */
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(JSON.stringify({ ok: true, value }))
  }

  /**
   * 新进程起来时把上一轮残留的 LAN 成员清掉。
   *
   * peerId 是每个进程现发的，进程一死它就没有任何意义了；可成员是落盘的。
   * 不清的话，宿主重启后屋里会留着一批「幽灵」—— 永远不回话，看着还像在线。
   */
  function pruneStalePeers() {
    let removed = 0
    store.commit((draft) => {
      for (const room of draft.rooms) {
        if (room.remote) continue
        const owners = new Set(
          room.members.filter((member) => member.owner && member.owner !== 'local').map((member) => member.owner),
        )
        // 人先撤，身份留下（keepSeat）：那台机器回来时还是同一个人 —— 它自己过去说的话、
        // 已读游标、椅子上的位置都还认得出它。peerId 是上一个进程发的，早就没意义了。
        for (const owner of owners) {
          removed += removePeer(draft, { roomId: room.id, peerId: owner, keepSeat: true }).length
        }
      }
    })
    if (removed) log('lan_pruned_stale', removed)
  }

  /**
   * 跑着的宿主也要清扫：对面关了窗口，peer 就再没人轮询。
   *
   * 不扫的话，屋子里会一直留着它的成员 —— 界面显示「在线」，@ 它也不回，
   * 只能等宿主自己重启。扫的动作和重启时的清理一样：整组撤掉。
   * 正在等回归的 assignment 不清（那是「还在说话」，不是「跑了」）。
   */
  function sweep() {
    const now = Date.now()
    const dropped = [...peers.values()].filter((peer) => !alive(peer, now))
    for (const peer of dropped) {
      peers.delete(peer.id)
      try {
        store.commit((draft) => {
          // 只是暂时不见了（关窗口、拔网线）：席位留着，回来还是同一个人。
          removePeer(draft, { roomId: peer.roomId, peerId: peer.id, keepSeat: true })
        })
      } catch (error) {
        // 屋子已经被解散：成员跟着屋子一起没了，不是错误。
        log('lan_sweep_skip', { peer: peer.id, error })
      }
      log('lan_peer_gone', { machine: peer.machine, address: peer.address })
    }
    if (dropped.length) wake()
    return dropped.length
  }

  async function start(wantPort = port ?? defaultPort()) {
    if (server) return status()
    closed = false
    lastError = null
    pruneStalePeers()
    const next = createServer((request, response) => {
      /**
       * 兜底。
       *
       * 这个回调抛出的任何东西都会变成一次未处理的拒绝，而 Node 对未处理的拒绝是
       * 「当作未捕获异常」—— 宿主进程直接退出。实测一个 `Host: [` 就能把整个
       * DSH 带走（见 test/lan-hardening.test.mjs）。请求面是对局域网开着的，
       * 所以这里宁可回 500 也绝不能让异常逃出去。
       */
      const swallowed = (error) => {
        log('lan_request_failed', { error: String(error?.message ?? error) })
        if (response.destroyed || response.writableEnded) return
        try {
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          response.end(
            JSON.stringify({ ok: false, error: { code: 'internal_error', message: '宿主处理这个请求时出错了。' } }),
          )
        } catch {
          /* 连接已经坏了，写不回去也没关系 */
        }
      }
      try {
        route(request, response).catch(swallowed)
      } catch (error) {
        swallowed(error)
      }
    })
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          next.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          next.off('error', onError)
          resolve()
        }
        next.once('error', onError)
        next.once('listening', onListening)
        next.listen(wantPort, '0.0.0.0')
      })
    } catch (error) {
      lastError =
        error?.code === 'EADDRINUSE'
          ? `端口 ${wantPort} 被占用了。关掉占着它的程序，或用 DSH_CHATROOM_PORT 换一个端口。`
          : String(error?.message ?? error)
      log('lan_listen_failed', lastError)
      await new Promise((resolve) => next.close(() => resolve()))
      return status()
    }
    server = next
    bound = { port: next.address()?.port ?? wantPort }
    sweeper = setInterval(sweep, sweepMs())
    sweeper.unref?.()
    log('lan_listening', bound.port)
    return status()
  }

  async function stop() {
    closed = true
    if (sweeper) {
      clearInterval(sweeper)
      sweeper = null
    }
    for (const row of assignments.values()) {
      row.done = true
      clearTimeout(row.timer)
      row.reject(Object.assign(new Error('宿主已停止。'), { code: 'lan_closed' }))
    }
    assignments.clear()
    peers.clear()
    wake()
    const current = server
    server = null
    bound = { port: null }
    if (current) {
      current.closeAllConnections?.()
      await new Promise((resolve) => current.close(() => resolve()))
    }
    return status()
  }

  return { start, stop, status, enqueue, sweep, peers, assignments, membersOfPeer, get address() { return bound.port ? `${hostname()}:${bound.port}` : null } }
}
