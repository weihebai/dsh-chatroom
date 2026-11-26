import { randomUUID } from 'node:crypto'
import { promptFromFacts } from './speak.js'
import { hostname } from 'node:os'
import { BUILD, baseUrl, fail, getJson, parseTarget, postJson } from './lan.js'
import { isWhaleColor } from './palette.js'
import { project } from './project.js'

/**
 * LAN 加入者：我这台机器加入别人机器上的房间。
 *
 * 关键取舍：**不把别人的房间当成本地房间**。
 *   - 本地只保留一份镜像（room.remote 非空），所有写操作转发给宿主；
 *   - 我的人与 agent 在宿主那边是 owner=peerId 的成员，轮到他们时宿主派发过来，
 *     我用自己机器上的原生 session 跑完再回传（记忆长在我这台机器上，这才是「带着自己的 agent」）；
 *   - 镜像写进同一个 state 与同一个投影，所以客户端的界面代码一行都不用分叉。
 */

/**
 * 宿主回的投影里「我」在这间屋里坐的那一档。
 *
 * 加入/改名的返回值都带 snapshot（宿主那边刚 commit 过），颜色以它为准：
 * 我们报的那一档可能被宿主按空档改过，信自己报的值会和对面显示成两种颜色。
 */
function hostSelfColor(value) {
  const rooms = value?.snapshot?.rooms ?? []
  const room = rooms.find((row) => row.id === value?.roomId) ?? rooms[0]
  const member = room?.members?.find((row) => row.id === value?.selfMemberId)
  return isWhaleColor(member?.color) ? member.color : null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const shortId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`

/**
 * 把宿主投影里的一间屋子变成本地镜像。
 * 视角要翻过来：宿主眼里的「本机」在这台机器上是「远程」，反之亦然 ——
 * 否则两边都以为自己是本地，界面就分不出消息从哪来。
 */
function mirrorRoom(record, snapshot) {
  const source = (snapshot?.rooms ?? []).find((room) => room.id === record.roomId)
  if (!source) return null
  // 两边各有一个「自己」：宿主那边的 self 成员 id 固定是 'me'，我这边的 self 也是 'me'。
  // 镜像里只能有一个 'me'（否则消息会被认成自己发的），所以把宿主的换成 host_xxx。
  const hostSelfId = `host_${record.peerId.slice(-6)}`
  const remap = (id) => {
    if (id === record.selfMemberId) return 'me'
    if (id === 'me') return hostSelfId
    return id
  }
  // 「我们这边」包括我的人和我带的 agent：他们说的话在本地视角都是本机，
  // 只有别人的话才标 LAN（否则自己的 agent 一发言就被标成远程，看着像串台）。
  const myMemberIds = new Set(
    (source.members ?? []).filter((member) => member.owner === record.peerId).map((member) => member.id),
  )
  const members = (source.members ?? []).map((member) => {
    const mine = member.owner === record.peerId
    if (mine) {
      return { ...member, id: remap(member.id), origin: { kind: 'local', peer: null, machine: record.machine }, owner: 'local' }
    }
    const machine = member.origin?.machine || member.origin?.peer || record.hostMachine
    return { ...member, id: remap(member.id), origin: { kind: 'lan', peer: machine, machine }, owner: 'remote' }
  })
  const messages = (source.messages ?? []).map((message) => {
    const mine = message.authorId === record.selfMemberId || myMemberIds.has(message.authorId)
    const machine = mine ? record.machine : message.origin?.machine || record.hostMachine
    return {
      ...message,
      authorId: remap(message.authorId),
      mentions: (message.mentions ?? []).map(remap),
      origin: mine ? { kind: 'local', peer: null, machine: record.machine } : { kind: 'lan', peer: machine, machine },
    }
  })
  return {
    id: record.localRoomId,
    code: source.code,
    name: source.name,
    topic: source.topic,
    createdAt: source.createdAt,
    ownerId: 'remote',
    remote: {
      host: record.host,
      port: record.port,
      peerId: record.peerId,
      machine: record.hostMachine,
      roomId: record.roomId,
    },
    rules: { ...source.rules },
    activity: source.activity ?? null,
    nextSeq: source.nextSeq,
    reads: {},
    members,
    messages,
    unread: source.unread ?? 0,
    truncated: Boolean(source.truncated),
  }
}

export function createLanGuest({ store, runner, gate = null, log = () => {} } = {}) {
  /** linkId → {stopped, controller, rejoining} —— 只放运行时，不落盘。 */
  const runtimes = new Map()

  const links = () => store.state.links ?? []
  const linkById = (id) => links().find((link) => link.id === id) ?? null
  const linkByRoom = (roomId) => links().find((link) => link.localRoomId === roomId) ?? null

  /**
   * 报给宿主看的「我是谁」。
   *
   * color 是**这间屋里我坐的那一档**，不是「我这个人的颜色」—— 颜色跟着房间走。
   * colorPicked 只在加入表单里真的选了颜色时为 true：宿主据此拒绝「抢别人那一档」；
   * 自动重连报的是上次坐的那一档，被占了由宿主换一档，不让重连整条断掉。
   */
  const selfPayload = (color, picked) => ({
    id: store.state.self.id,
    name: store.state.self.name,
    color: isWhaleColor(color) ? color : null,
    colorPicked: picked === true,
  })
  /**
   * 报给宿主看的「我带谁」。agent 包里不带颜色：颜色是宿主屋里的一项座位，
   * 由宿主按空档安排。人给自己屋里的 agent 挑色走 member.update，不经过这里。
   */
  const agentsPayload = () => store.state.bots.map((bot) => ({ id: bot.id, name: bot.name, role: bot.role }))
  /**
   * 某一间屋该报哪些 agent。默认全带；这间屋里被移出的记在 link.agentExcluded 里，
   * 这样「移出这间屋」只影响这一条链接（也就是这一间屋），agent 本体和别的房间都不动。
   */
  const agentsPayloadFor = (link) => {
    const excluded = new Set(link?.agentExcluded ?? [])
    return store.state.bots
      .filter((bot) => !excluded.has(bot.id))
      .map((bot) => ({ id: bot.id, name: bot.name, role: bot.role }))
  }

  function runtimeOf(linkId) {
    let runtime = runtimes.get(linkId)
    if (!runtime) {
      runtime = { stopped: false, controller: new AbortController(), rejoining: 0, failedAt: 0 }
      runtimes.set(linkId, runtime)
    }
    return runtime
  }

  /** 已在本地留下墓碑：房间还在列表里，标成已解散，用户能自己清理。 */
  function paintGone(draft, record) {
    const room = draft.rooms.find((row) => row.id === record.localRoomId)
    if (!room) return
    room.remote = { ...room.remote, lost: true }
    room.unread = 0
    room.activity = null
  }

  function upsertMirror(draft, record, snapshot) {
    draft.links = (draft.links ?? []).filter((link) => link.id !== record.id).concat(record)
    const next = mirrorRoom(record, snapshot)
    preserveBindings(next, record.localRoomId)
    if (!next) {
      paintGone(draft, record)
      return
    }
    draft.rooms = draft.rooms.filter((room) => room.id !== record.localRoomId)
    draft.rooms.push(next)
    // 刚加入就把视图切过去：用户下一步一定是想说话，而不是回到本机空房间。
    draft.activeRoomId = next.id
  }

  /**
   * 关停途中的写入。
   *
   * 插件被关掉/重载时 store 先关、循环还在飞：回程里的状态更新会抛 `closed`。
   * 那不是错误；可它一旦从后台循环里逃出去就是一次未处理的拒绝 ——
   * 而 Node 把未处理的拒绝当未捕获异常，会把整个 DSH 进程带走。
   */
  function quietCommit(mutate) {
    try {
      store.commit(mutate)
    } catch (error) {
      if (error?.code !== 'closed') throw error
    }
  }

  function markStatus(linkId, { status, error = null, peerId, selfMemberId }) {
    quietCommit((draft) => {
      const link = (draft.links ?? []).find((row) => row.id === linkId)
      if (!link) return
      if (status) link.status = status
      link.error = error
      if (peerId) link.peerId = peerId
      if (selfMemberId) link.selfMemberId = selfMemberId
    })
  }

  /**
   * 记下「对面那台插件的版本够不够」。
   *
   * 只有真的打到 404 才置位：说明对方没有 /lan/agents 这条路，也就是旧版本。
   * 这条信息必须能出现在界面上 —— 否则用户只会看到「agent 进不来」，
   * 而真正要做的事是重启对面的桌面端。
   */
  function markHostOld(linkId, hostOld) {
    const link = linkById(linkId)
    if (!link || Boolean(link.hostOld) === hostOld) return
    quietCommit((draft) => {
      const row = (draft.links ?? []).find((item) => item.id === linkId)
      if (row) row.hostOld = hostOld
    })
  }

  /** 停掉一条链接的两个长轮询（离开、或屋子已经没了）。 */
  function stopRuntime(linkId) {
    const runtime = runtimes.get(linkId)
    if (!runtime) return
    runtime.stopped = true
    runtime.controller.abort()
    runtimes.delete(linkId)
  }

  // 镜像会被宿主快照替换；本机的会话绑定不能被对端空 sessionId 覆盖。
  function preserveBindings(next, localRoomId) {
    if (!next) return
    const previous = store.state.rooms.find((room) => room.id === localRoomId)
    for (const member of next.members) {
      if (member.origin?.kind !== 'local' || !member.botId) continue
      const local = previous?.members.find((row) => row.botId === member.botId && row.sessionBound === true)
      if (!local) continue
      for (const key of ['sessionId', 'sessionBound', 'external', 'previousSessionId', 'previousExternal', 'previousSessionBound']) {
        if (Object.hasOwn(local, key)) member[key] = local[key]
      }
    }
  }

  function applyRemote(linkId, snapshot) {
    const record = linkById(linkId)
    if (!record) return null
    const next = mirrorRoom(record, snapshot)
    preserveBindings(next, record.localRoomId)
    // 宿主那边把这间屋子解散了：投影里没有它了。
    // 不能就此把镜像悄悄删掉 —— 那会让加入方卡在一个「发不出去、也没有离开入口」的状态里。
    // 留一张墓碑：房间还在列表里，标成已解散，用户能自己把它清掉。
    const gone = !next && Boolean(store.state.rooms.find((room) => room.id === record.localRoomId))
    store.commit((draft) => {
      const link = (draft.links ?? []).find((row) => row.id === linkId)
      if (link) {
        link.status = gone ? 'gone' : 'online'
        link.error = gone ? '这间屋子已经在宿主那台机器上解散了。' : null
      }
      if (next) {
        draft.rooms = draft.rooms.filter((room) => room.id !== record.localRoomId)
        draft.rooms.push(next)
        return
      }
      paintGone(draft, record)
    })
    if (gone) {
      stopRuntime(linkId)
      log('lan_room_gone', { link: linkId })
    }
    return next
  }

  /**
   * 宿主重启 / 它那侧进程换了，peerId 立刻失效（这是有意的：宁可让对面重连，
   * 也不拿旧身份错认人）。所以任何一次转发撞上 peer_unknown 时，自己重新握手
   * 再来一次 —— 用户不该因为对面刚重启就看到一句「凭据失效」。
   */
  async function withPeer(record, run) {
    const fresh = linkByRoom(record.localRoomId) ?? record
    if (fresh.status === 'gone') fail('remote_room_gone', '这间屋子已经在宿主那台机器上解散了。')
    try {
      return await run(fresh)
    } catch (error) {
      if (error?.code !== 'peer_unknown') throw error
      const value = await rejoin(fresh.id).catch(() => null)
      if (!value) throw error
      const next = linkByRoom(fresh.localRoomId)
      if (!next) throw error
      return run(next)
    }
  }

  async function join(input = {}) {
    const { host, port } = parseTarget(input.host ?? input.address, input.port)
    const code = String(input.code ?? '').trim().toUpperCase()
    if (!code) fail('code_required', '房间码不能为空。')
    const existing = links().find((link) => link.host === host && link.port === port && link.code === code)
    const linkId = existing?.id ?? shortId('ln')
    const localRoomId = existing?.localRoomId ?? shortId('rm_lan')
    const machine = String(input.machine ?? '').trim().slice(0, 64) || hostname()
    // 加入表单里选的那一档。没选（自动重连、旧界面）就沿用上次坐的那一档：
    // 先看这条 link 记着的，再看本机镜像里「我」的颜色 —— 后者是宿主现在认的值。
    const explicit = isWhaleColor(input.color) ? input.color : null
    const mirror = existing ? store.state.rooms.find((room) => room.id === existing.localRoomId) : null
    const held = mirror?.members?.find((member) => member.id === 'me')?.color
    const color = explicit ?? (isWhaleColor(existing?.color) ? existing.color : isWhaleColor(held) ? held : null)
    const value = await postJson(
      `${baseUrl(host, port)}/lan/join`,
      {
        code,
        machine,
        // 这张 link 的 id 就是「我这台现在这条连接」的稳定身份：它落盘，
        // 桌面端重启、插件重载之后还是同一个值。宿主靠它认出「是同一个人回来了」，
        // 而不是把旧那组留着当另一个人（见 lan-host.js 的接管逻辑）。
        instance: linkId,
        // 名字与这间屋的虎鲸座位一起报：加入表单里选过色的，colorPicked=true，
        // 宿主会拒绝「抢别人那一档」而不是替他换一档。
        self: selfPayload(color, Boolean(explicit)),
        agents: agentsPayloadFor(existing),
        build: BUILD,
      },
      { timeoutMs: 15_000 },
    )
    const record = {
      id: linkId,
      host,
      port,
      code,
      machine,
      // 这一档记在 link 上：重连时不用再问界面，也不会把颜色弄丢。
      // 以宿主回的投影为准（它可能按空档给了一档），拿不到才用刚才报的那个。
      color: hostSelfColor(value) ?? color,
      peerId: value.peerId,
      hostMachine: value.hostMachine ?? null,
      roomId: value.roomId,
      localRoomId,
      selfMemberId: value.selfMemberId,
      status: 'online',
      error: null,
      // 重新握手就是重新确认对方版本：上一次的 404 不能留在这条链路上。
      hostOld: false,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }
    store.commit((draft) => upsertMirror(draft, record, value.snapshot))
    start(linkId)
    return record
  }

  /**
   * 换一个新的 peerId 重新握手。
   *
   * 并发去重：长轮询和「用户正在发言」很可能同时撞上旧凭据，两边各自 join 一次
   * 就会在宿主那边建出两套成员（屋里出现两个「周荻」）。所以同一时刻只允许一次握手，
   * 后来的人等同一个 promise。失败后压 3 秒再试，避免对着关掉的机器刷请求。
   */
  async function rejoin(linkId) {
    const record = linkById(linkId)
    if (!record) return null
    const runtime = runtimeOf(linkId)
    if (runtime.rejoining) return runtime.rejoining
    if (runtime.failedAt && Date.now() - runtime.failedAt < 3000) return null
    const run = (async () => {
      try {
        const value = await postJson(
          `${baseUrl(record.host, record.port)}/lan/join`,
          {
            code: record.code,
            machine: record.machine,
            instance: record.id,
            // 重连不是「重新挑颜色」：报上次坐的那一档，colorPicked=false ——
            // 被占了由宿主按空档安排，不让整条连接因为一个颜色断掉。
            self: selfPayload(record.color, false),
            agents: agentsPayloadFor(record),
            build: BUILD,
          },
          { timeoutMs: 15_000 },
        )
        runtime.failedAt = 0
        store.commit((draft) => {
          const next = {
            ...record,
            // 宿主可能重新安排了一档（原来那档被人占了）：以它的投影为准。
            color: hostSelfColor(value) ?? record.color,
            peerId: value.peerId,
            selfMemberId: value.selfMemberId,
            status: 'online',
            error: null,
            hostOld: false,
          }
          upsertMirror(draft, next, value.snapshot)
        })
        return value
      } catch (error) {
        runtime.failedAt = Date.now()
        markStatus(linkId, { status: 'offline', error: String(error?.message ?? error).slice(0, 200) })
        return null
      }
    })()
    runtime.rejoining = run
    try {
      return await run
    } finally {
      runtime.rejoining = 0
    }
  }

  function start(linkId) {
    const runtime = runtimeOf(linkId)
    if (runtime.started) return
    runtime.started = true
    // 两个后台循环的最后一道口子：真漏出异常也只记一条日志，不让它变成未处理的拒绝
    // （那会被 Node 当成未捕获异常，直接把宿主进程带走）。
    const failed = (loop) => (error) => log(loop, { error: String(error?.message ?? error) })
    void stateLoop(linkId, runtime).catch(failed('lan_state_loop_failed'))
    void assignmentLoop(linkId, runtime).catch(failed('lan_assignment_loop_failed'))
  }

  async function stateLoop(linkId, runtime) {
    let since = -1
    while (!runtime.stopped) {
      const record = linkById(linkId)
      if (!record) break
      try {
        const value = await getJson(
          `${baseUrl(record.host, record.port)}/lan/state?peerId=${encodeURIComponent(record.peerId)}&since=${since}`,
          { timeoutMs: 40_000, signal: runtime.controller.signal },
        )
        since = Number(value.revision ?? since)
        applyRemote(linkId, value.snapshot)
      } catch (error) {
        if (runtime.stopped) break
        if (error?.code === 'peer_unknown') {
          since = -1
          const value = await rejoin(linkId)
          if (runtime.stopped) break
          // 重新握手也失败时不能立刻再试：403 是秒回的，rejoin 里又有 3 秒熔断会秒回 null，
          // 两句凑一起就是「一秒打对面几百次」的紧循环（实测 2.5 秒 750 次）。房间被解散、
          // 地址上换了一台机器都会走到这里，对方可能正在重启，不该被我们按着打。
          if (!value) await sleep(1500)
          continue
        }
        markStatus(linkId, { status: 'offline', error: String(error?.message ?? error).slice(0, 200) })
        await sleep(1500)
      }
    }
  }

  async function assignmentLoop(linkId, runtime) {
    while (!runtime.stopped) {
      const record = linkById(linkId)
      if (!record) break
      let value
      try {
        value = await getJson(
          `${baseUrl(record.host, record.port)}/lan/assignments?peerId=${encodeURIComponent(record.peerId)}`,
          { timeoutMs: 40_000, signal: runtime.controller.signal },
        )
      } catch (error) {
        if (runtime.stopped) break
        if (error?.code === 'peer_unknown') {
          const value = await rejoin(linkId)
          // 同上：握手没成功就先等一拍，别把长轮询变成对空地址的紧循环。
          if (!value) await sleep(1500)
          continue
        }
        await sleep(1500)
        continue
      }
      const assignment = value?.assignment
      if (!assignment) continue
      await runAssignment(record, assignment)
      if (runtime.stopped) break
    }
  }

  /** 宿主把「轮到某个 agent」派过来：用它自己机器上的原生 session 跑。 */
  async function runAssignment(record, assignment) {
    const bot = store.state.bots.find((row) => row.id === assignment.agentId)
    const send = (body) =>
      postJson(
        `${baseUrl(record.host, record.port)}/lan/reply`,
        { peerId: record.peerId, assignmentId: assignment.id, ...body },
        { timeoutMs: 15_000 },
      )
    if (!bot) {
      await send({ error: `本机没有「${assignment.memberName}」这个 agent` }).catch((error) =>
        log('lan_reply_failed', error),
      )
      return
    }
    const runtime = runtimes.get(record.id)
    /**
     * 本机授权：这条是别的机器派过来的，执行前按本机档位决定。
     *
     * 这一道不能省。host 那边发过来的是 prompt 全文，而本机 agent 用的是本机配置的
     * 工具权限 —— 不拦的话，房间里任何一个能触发派发的人，都能驱动这台机器上的 agent。
     */
    if (gate) {
      const room = store.state.rooms.find((row) => row.id === record.localRoomId)
      if (gate.level() === 'ask') {
        // 先请宿主把这一轮的等待延长：默认 45 秒的窗口不够人想清楚。
        // 老宿主没有这条路由（404）也只是回到原来的窗口，不影响正确性。
        await postJson(
          `${baseUrl(record.host, record.port)}/lan/hold`,
          { peerId: record.peerId, assignmentId: assignment.id, ms: gate.waitMs() + 15_000 },
          { timeoutMs: 8000 },
        ).catch((error) => {
          if (error?.code !== 'not_found') log('lan_hold_failed', error)
        })
      }
      const verdict = await gate.check({
        roomId: record.localRoomId,
        roomName: room?.name ?? '',
        agentName: bot.name,
        prompt: assignment.prompt,
        from: assignment.from,
        signal: runtime?.controller?.signal ?? null,
      })
      if (!verdict.ok) {
        // 关停 / 离开房间：这一轮已经不在了，别再往回发。
        if (verdict.reason === 'cancelled' || verdict.reason === 'closed') return
        log('lan_assignment_declined', { botId: bot.id, reason: verdict.reason })
        await send({ denied: verdict.reason }).catch((error) => log('lan_reply_failed', error))
        return
      }
    }
    try {
      // 外部成员背后是本机正在用的那个会话：它可能还在跑自己的回合，先等空闲再递话。
      const room = store.state.rooms.find((row) => row.id === record.localRoomId)
      const bound = room?.members.find((member) => member.botId === assignment.agentId && member.origin?.kind === 'local' && member.sessionBound === true)
      const sessionBot = bound ? { ...bot, sessionId: bound.sessionId, external: bound.external === true } : bot
      // 提示词在本机拼：成员「本机/宿主」按这台机器算，不依赖宿主视角；
      // 旧宿主没有 facts 时退回它给的整段 prompt。
      const prompt = assignment.facts ? promptFromFacts(assignment.facts, { selfKey: record.peerId }) : assignment.prompt
      const { text } = await runner.say({ ...sessionBot, cwd: bot.cwd ?? undefined }, prompt, {
        waitIdleFirst: sessionBot.external === true,
      })
      await send({ text })
    } catch (error) {
      log('lan_assignment_failed', { botId: bot.id, error })
      await send({ error: String(error?.code ?? error?.message ?? error).slice(0, 160) }).catch(() => {})
    }
  }

  async function send({ roomId, text, mentions, replyTo, opKey, authorBotId, silent }) {
    const record = linkByRoom(roomId)
    if (!record) fail('remote_room_unknown', '这个房间不是从别的机器同步来的。')
    return withPeer(record, async (peer) => {
      // 本地的 'me' 在宿主那边是它自己的成员，必须换回我这台机器的成员 id，
      // 否则「@我自己」会点到对面的人。
      const declared = (Array.isArray(mentions) ? mentions : []).map((id) => (id === 'me' ? peer.selfMemberId : id))
      const value = await postJson(
        `${baseUrl(peer.host, peer.port)}/lan/message`,
        {
          peerId: peer.peerId,
          text,
          mentions: declared,
          replyTo,
          opKey,
          // 以本机某个 agent 的身份发：宿主只认「这条连接名下」的 agent，冒不了别人的名。
          ...(authorBotId ? { authorBotId } : {}),
          // 只落一条消息、不触发任何回合（完成通知用）。
          ...(silent === true ? { silent: true } : {}),
        },
        { timeoutMs: 20_000 },
      )
      applyRemote(peer.id, value.snapshot)
      return value
    })
  }

  async function read({ roomId, seq }) {
    const record = linkByRoom(roomId)
    if (!record) return null
    return withPeer(record, async (peer) => {
      const value = await postJson(`${baseUrl(peer.host, peer.port)}/lan/read`, {
        peerId: peer.peerId,
        seq,
      })
      if (value?.snapshot) {
        applyRemote(peer.id, value.snapshot)
        return value
      }
      store.commit((draft) => {
        const room = draft.rooms.find((row) => row.id === roomId)
        if (!room) return
        room.unread = room.messages.filter((message) => message.seq > seq && message.authorId !== 'me').length
      })
      return value
    })
  }

  /**
   * 往回翻历史：本机只镜像了宿主最近 200 条，更早的在宿主那台机器上。
   *
   * 请求里只带 beforeSeq / limit —— 房间由这张 link 决定（宿主按 peerId 认房间），
   * 所以就算有人把 roomId 改掉，也只能翻到自己已经加入的那间屋子。
   */
  async function page({ roomId, beforeSeq, limit }) {
    const record = linkByRoom(roomId)
    if (!record) fail('remote_room_unknown', '这间屋子不是从别的机器同步来的。')
    return withPeer(record, async (peer) => {
      const value = await postJson(
        `${baseUrl(peer.host, peer.port)}/lan/messages`,
        { peerId: peer.peerId, beforeSeq, limit },
        { timeoutMs: 8000 },
      )
      return {
        messages: Array.isArray(value?.messages) ? value.messages : [],
        hasMore: Boolean(value?.hasMore),
        firstSeq: value?.firstSeq ?? null,
        total: typeof value?.total === 'number' ? value.total : null,
      }
    })
  }

  async function rename(name) {
    const label = String(name ?? '').trim().slice(0, 60)
    if (!label) return null
    for (const record of links()) {
      await postJson(
        `${baseUrl(record.host, record.port)}/lan/self`,
        { peerId: record.peerId, name: label },
        { timeoutMs: 8000 },
      )
        .then((value) => {
          // 宿主把改名后的投影带回来了：顺手刷一遍镜像，别等下一轮长轮询。
          if (value?.snapshot) applyRemote(record.id, value.snapshot)
        })
        .catch((error) => log('lan_rename_failed', error))
    }
    return { renamed: true }
  }

  /**
   * 换我在这间屋里坐的那一档虎鲸。
   *
   * 颜色跟着房间走，所以只能改「这间屋里的我」：linkId 指明是哪间屋子的宿主。
   * 被同屋别人占了的颜色，宿主会回 color_taken —— 这个错误**不能吞掉**，
   * 要原样抛给界面，让人自己换一档（悄悄换掉的话，他挑的就不是这个颜色了）。
   * 成功时宿主把新投影带回来，镜像当场换成这一档。
   */
  async function setColor(linkId, color) {
    if (!isWhaleColor(color)) fail('bad_color', '颜色不在可选范围内。')
    const record = linkById(linkId)
    if (!record) fail('link_not_found', '这条局域网连接已经不在了。')
    const value = await withPeer(record, (peer) =>
      postJson(
        `${baseUrl(peer.host, peer.port)}/lan/self`,
        { peerId: peer.peerId, color },
        { timeoutMs: 8000 },
      ),
    )
    if (value?.snapshot) applyRemote(record.id, value.snapshot)
    return value
  }

  /**
   * 把本机现在的 agent 名单报给宿主。
   *
   * 加入那一刻报过一次，但「先挤进屋、再想起带谁」才是常态 —— 新装的机器上一个
   * agent 都没有。不补这一步，屋里就永远只有他一个人，而对面的成员列毫无提示。
   * 改名/改职责、删掉 agent 也走这条：宿主那边对账，历史消息保留当时的署名。
   */
  async function announceAgents(onlyId = null) {
    const records = links().filter((record) => record.status !== 'gone' && (!onlyId || record.id === onlyId))
    let last = null
    for (const record of records) {
      last = await withPeer(record, async (peer) => {
        const value = await postJson(
          `${baseUrl(peer.host, peer.port)}/lan/agents`,
          {
            peerId: peer.peerId,
            agents: agentsPayloadFor(peer),
          },
          { timeoutMs: 8000 },
        )
        if (value?.snapshot) applyRemote(peer.id, value.snapshot)
        // 这一次报成功了：对面不是旧版本（或已经重启换成新版），提示可以撤掉。
        markHostOld(peer.id, false)
        return value
      }).catch((error) => {
        // 404 = 对面根本没有这个端点。这是版本不一致，不是网络故障：
        // 记下来让界面直说「宿主的插件是旧版本」，别让人反复重试。
        if (error?.code === 'not_found') markHostOld(record.id, true)
        log('lan_announce_failed', { link: record.id, error })
        return null
      })
    }
    return last
  }

  /**
   * 把某个本机 agent 放进/移出某间镜像房间：只改这条链接的排除名单，再单独向它报一次。
   * 宿主按名单对账，多退少补；其他房间各自一份名单，互不影响。
   */
  async function setAgentInRoom(roomId, botId, included) {
    const record = linkByRoom(roomId)
    if (!record) fail('remote_room_not_found', '这间屋子不是从本机加入的，改不了它的成员。')
    store.commit((draft) => {
      const link = (draft.links ?? []).find((row) => row.id === record.id)
      if (!link) return
      const set = new Set(link.agentExcluded ?? [])
      if (included) set.delete(botId)
      else set.add(botId)
      link.agentExcluded = [...set]
    })
    return announceAgents(record.id)
  }

  async function leave(linkId) {
    const record = linkById(linkId)
    const runtime = runtimes.get(linkId)
    if (runtime) {
      runtime.stopped = true
      runtime.controller.abort()
      runtimes.delete(linkId)
    }
    if (record && record.status !== 'gone') {
      await postJson(
        `${baseUrl(record.host, record.port)}/lan/leave`,
        { peerId: record.peerId },
        { timeoutMs: 8000 },
      ).catch((error) => log('lan_leave_failed', error))
    }
    store.commit((draft) => {
      draft.links = (draft.links ?? []).filter((link) => link.id !== linkId)
      if (!record) return
      draft.rooms = draft.rooms.filter((room) => room.id !== record.localRoomId)
      if (draft.activeRoomId === record.localRoomId) draft.activeRoomId = draft.rooms[0]?.id ?? null
    })
    return { left: true }
  }

  /** 进程重启后把上次加入的房间接回来：宿主那边的 peerId 已经失效，重新握手。 */
  async function resume() {
    for (const record of links()) {
      // 已经解散的屋子没有再握手的意思：重新 join 只会拿到 room_not_found，
      // 白白把「已解散」这条状态覆盖成「离线」。
      if (record.status === 'gone') continue
      try {
        await join({ host: record.host, port: record.port, code: record.code, machine: record.machine })
      } catch (error) {
        log('lan_resume_failed', { link: record.id, error })
        markStatus(record.id, { status: 'offline', error: String(error?.message ?? error).slice(0, 200) })
      }
    }
  }

  function snapshotView() {
    return project(store.state, { viewerId: store.state.self.id })
  }

  async function stop() {
    for (const [linkId, runtime] of runtimes) {
      runtime.stopped = true
      runtime.controller.abort()
      runtimes.delete(linkId)
    }
  }

  return { join, leave, send, read, page, rename, setColor, resume, stop, snapshotView, linkByRoom, links, announceAgents, setAgentInRoom }
}
