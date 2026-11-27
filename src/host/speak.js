import { botsOf, getMember, getRoom, isExternalMember, isRemoteMember, mentionedBots, postMessage, transcriptOf } from './rooms.js'

/**
 * 三条发言规则并行存在 —— 这就是它们的调度器。
 *
 * 规则不是三选一，而是三个同时生效的开关：
 *   mention   被 @ 的 agent 一定回（永远开的兜底）
 *   chair     有主持人时，先把话交给主持人；主持人回复里 @ 了谁，就继续接给谁
 *   roundRobin 人发言后，所有 agent 依次各说一句（「让全员说一轮」走的也是这条）
 *
 * 三条同时开会撞车，所以有一个总预算：一条人消息最多引出 rules.maxSpeakers
 * 个 agent 回合，agent 之间接力最多 rules.maxDepth 层。预算烧完就停 ——
 * 这是防止一屋子 agent 互相客套把 token 烧光的唯一闸门。
 *
 * 另外两条硬规矩，都是从真实使用里踩出来的：
 *   · 一轮之内同一个人只说一次。主持人 @ 了 B，全员轮次的队列里也有 B，
 *     B 不该说两句、更不该把预算吃光让排在后面的人永远轮不到。
 *   · 正在发言时人又说了一句，那句不能丢。真实房间里一轮要好几秒，
 *     用户就是在这时候插话的；悄悄吞掉等于「@ 了没有反应」。
 */

const fail = (code, message) => {
  throw Object.assign(new Error(message ?? code), { code })
}

/**
 * 「这一轮是被叫停的」而不是「它回不上来」。
 *
 * 真 turn.js 被 abort 时抛 code: 'cancelled'；远程派发那边可能给 AbortError。
 * 两者都算用户自己按了停 —— 不是这个 agent 的失败，不该在屋里留红色占位。
 */
const isCancelled = (error) => {
  const code = String(error?.code ?? '')
  return code === 'cancelled' || code === 'aborted' || error?.name === 'AbortError'
}

/**
 * 派发出去等对面机器时也得能喊停：本机点「停下这一轮」就不要再等。
 * 宿主那边的 assignment 会在超时后自己收尾，所以这里丢下它不会留下半个回合。
 */
function withAbort(promise, signal) {
  if (!signal) return promise
  const aborted = new Promise((_, reject) => {
    const stop = () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }))
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
  return Promise.race([promise, aborted])
}

export function promptFactsFor({ room, bot, at }) {
  const visible = room.messages.filter((message) => message.status !== 'error' && message.status !== 'notice')
  const mineAt = visible.map((message) => message.authorId).lastIndexOf(bot.id)
  const tail = visible.slice(Math.max(0, mineAt + 1)).slice(-6)
  const transcript = tail
    .map((message, index) => {
      const human = message.authorKind === 'human'
      const body = message.text.length > 200 ? message.text.slice(0, 200) + '…' : message.text
      const origin = message.origin?.kind === 'lan' ? '〔远程〕' : ''
      return '#' + (index + 1) + ' ' + origin + message.authorName + '（' + (human ? '人' : 'agent') + '）：' + body
    })
    .join('\n')
  const mine = visible.filter((message) => message.authorId === bot.id).at(-1)
  const waiting = visible.filter((message) => (message.mentions ?? []).includes(bot.id)).at(-1)
  return {
    botName: bot.name,
    role: bot.role ? String(bot.role).slice(0, 80) : '',
    roomName: room.name,
    topic: room.topic || '',
    maxChars: room.rules.maxChars,
    at,
    overLimit: Boolean(mine && mine.text.length > room.rules.maxChars),
    waiting: waiting ? { authorName: waiting.authorName, text: waiting.text.slice(0, 400) } : null,
    members: room.members.map((member) => ({
      name: member.name,
      kind: member.kind === 'human' ? 'human' : 'agent',
      role: member.role ? String(member.role).slice(0, 40) : '',
      machineKey: member.origin?.kind === 'lan' ? member.origin.peer || 'remote' : 'host',
      machine: member.origin?.kind === 'lan' ? member.origin.machine || member.origin.peer || '远程' : '',
    })),
    transcript,
  }
}

export function promptFromFacts(facts, { selfKey = 'host' } = {}) {
  const memberLine = facts.members
    .map((member) => {
      const kind = member.kind === 'human' ? '人' : 'agent'
      const self = member.machineKey === selfKey
      const where = self
        ? (selfKey === 'host' ? '，本机' : '，本机（你这台机器）')
        : member.machineKey === 'host'
          ? '，宿主那台机器'
          : '，从 LAN 进来（' + (member.machine || '远程') + '）'
      const role = member.role ? '，' + member.role : ''
      return '- ' + member.name + '（' + kind + role + where + '）'
    })
    .join('\n')
  const ask = facts.at === 'chair'
    ? '你现在是主持人：一句话点明分歧，给出你的判断，需要谁补就 @ 谁。'
    : facts.at === 'round'
      ? '就上面的话题补一句你的结论或反驳，不要复述别人。'
      : (facts.waiting ? '「' + facts.waiting.authorName + '」等你处理（原文见下）。' : '有人等你回复。') + '先动手：读代码/改文件/跑命令，做完再回一条结果。'
  return [
    '你以「' + facts.botName + '」的身份在群聊「' + facts.roomName + '」里协作，目标是把两边的代码改完、功能跑通；你在这台机器上干活。',
    facts.role ? '你的职责：' + facts.role : '',
    '',
    '成员（谁在哪台机器）：',
    memberLine,
    '',
    '最近对话：',
    facts.transcript || '（还没有人说话）',
    '',
    ask,
    facts.waiting && facts.at === 'mention' ? '要处理的原文：' + facts.waiting.text : '',
    '回复要求：中文；第一句给结论或进展；写清改了什么、验证结果、下一步或卡点；不要寒暄、不要复述、不要只回「收到」；不超过 ' + facts.maxChars + ' 字；只输出这一条消息。',
    facts.overLimit ? '（你上一条超了 ' + facts.maxChars + ' 字上限，这条务必压缩。）' : '',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

function buildPrompt({ room, bot, at, viewerPeer = null }) {
  const facts = promptFactsFor({ room, bot, at })
  if (!viewerPeer) return promptFromFacts(facts, { selfKey: 'host' })
  // 兼容旧版加入方：它们没有 facts，只能收整段文本，按收件人视角渲染。
  return promptFromFacts(facts, { selfKey: viewerPeer })
}

export function createSpeaker({ store, runner, dispatchRemote = null, gate = null, log = () => {} }) {
  const running = new Set()
  const aborts = new Map()
  /** roomId → 这一轮的身份。用来分辨「收尾的是我吗」，避免旧回合把新回合收掉。 */
  const epochs = new Map()
  /** 发言中间收到的人消息：不丢，排到这一轮结束后接着处理。 */
  const pending = new Map()
  const PENDING_LIMIT = 8
  /**
   * 连续「由 agent 自己引出」的回合计数（roomId → 次数）。
   *
   * 人发的消息永远清零；agent 用 room 工具发的话才累加。到顶就不再自动开新一轮 ——
   * 没有这道闸，两个 agent 可以互相「收到」「好的」一直转下去，每一圈都是一次真实模型调用。
   */
  /**
   * roomId → (messageId|memberId → 派发时间)。
   * 同一条人消息对同一个 agent 只驱动一轮：重复提交、重试并发、LAN 重投递
   * 都不该让同一个问题被答两遍。
   */
  const dispatched = new Map()
  const DISPATCH_TTL = 60_000
  const autoRounds = new Map()
  /** roomId → 已经为这一串自动讨论发过「请房主拍板」的提醒（人一说话就清）。 */
  const escalated = new Set()

  /** sessionId → 正在生成的草稿。只在内存，不落库、不进历史；跑完由正式消息取代。 */
  const streams = new Map()

  function beginStream(sessionId, name, roomId) {
    if (!sessionId) return
    streams.set(sessionId, { roomId, name: name || '', text: '', at: 0 })
  }

  function endStream(sessionId) {
    const live = streams.get(sessionId)
    if (!live) return
    streams.delete(sessionId)
    store.commit((state) => {
      const room = getRoom(state, live.roomId)
      if (!room || !room.activity) return
      const next = { ...room.activity }
      delete next.streaming
      room.activity = Object.keys(next).length ? next : null
    })
  }

  /** 收一个 text-delta：攒着，最多 250ms 往房间推一次，别把长轮询刷爆。 */
  function pushStream(sessionId, text) {
    const live = streams.get(sessionId)
    if (!live || !text) return
    live.text = (live.text + text).slice(-2000)
    const now = Date.now()
    if (now - live.at < 250) return
    live.at = now
    store.commit((state) => {
      const room = getRoom(state, live.roomId)
      if (!room) return
      room.activity = { ...(room.activity ?? {}), streaming: { name: live.name, text: live.text } }
    })
  }

  /**
   * 这一轮是谁的话引出来的。
   *
   * 只关心一件事：它是不是从别的机器来的。非本机的指挥要过本机授权那道门
   * （见 guard.js）；本机的人自己说话、自己点重试、自己点全员轮次，都不问。
   */
  function triggerOf(message) {
    if (!message) return { kind: 'local', name: null, machine: null, authorKind: 'human' }
    const lan = message.origin?.kind === 'lan'
    return {
      kind: lan ? 'lan' : 'local',
      name: message.authorName ?? null,
      machine: lan ? message.origin.machine || message.origin.peer || null : null,
      authorKind: message.authorKind === 'bot' ? 'bot' : 'human',
      // 引出这一轮的原话：授权窗口里「对方说了什么」比整段 prompt 好读得多。
      text: String(message.text ?? '').slice(0, 400),
    }
  }

  /** 「这一轮没执行」的房间说明：不是失败占位，也不是谁说的话。 */
  const declineNote = (reason) =>
    reason === 'readonly'
      ? '本机授权是「只读」，这条远程指挥没有执行。要接受，在那台机器的成员列底部把「本机授权」改成「授权后执行」或「完全授权」。'
      : reason === 'timeout'
        ? '本机的人没有在时限内确认，这条远程指挥没有执行。'
        : '本机的人拒绝了这条远程指挥，没有执行。'

  function postDecline(roomId, botId, botName, reason) {
    store.commit((state) => {
      const room = getRoom(state, roomId)
      if (!room) return
      postMessage(state, {
        roomId,
        authorId: botId,
        text: `${botName}：${declineNote(reason)}`,
        status: 'notice',
      })
    })
  }

  function roomOrFail(roomId) {
    const room = store.inspect((state) => getRoom(state, roomId))
    if (!room) fail('room_not_found')
    return room
  }

  function setActivity(roomId, patch) {
    store.commit((state) => {
      const room = getRoom(state, roomId)
      if (!room) return
      room.activity = patch === null ? null : { ...(room.activity ?? {}), ...patch }
    })
  }

  async function speakOne({ roomId, botId, at, depth, budget, spoke, token, trigger = null, stall = null }) {
    if (budget.left <= 0) return
    // 一轮之内同一个人只说一次：主持人的 @ 和全员队列点到同一个人时，
    // 后到的那次直接跳过，把预算留给还没开口的人。
    if (spoke.has(botId)) return
    const room = roomOrFail(roomId)
    const bot = getMember(room, botId)
    if (!bot || bot.kind !== 'bot') return
    // 远程 agent 的目录不在本机：它的 session、模型、记忆都在它自己那台机器上，
    // 本机只负责「这一轮轮到你了」把 prompt 派过去。
    const remote = isRemoteMember(bot)
    const directoryBot = remote ? null : store.inspect((state) => state.bots.find((row) => row.id === bot.botId))
    // 房间绑定优先；未绑定时保留 agent 默认会话与旧版 external 路由。
    const roomBound = bot.sessionBound === true || isExternalMember(bot)
    const speakerBot = roomBound
      ? { ...directoryBot, id: directoryBot?.id ?? bot.id, sessionId: bot.sessionId, external: bot.external === true }
      : directoryBot
    const external = !remote && speakerBot?.external === true
    if (!remote && !speakerBot) {
      log('bot_missing', botId)
      return
    }
    const driveSession = !remote ? speakerBot?.sessionId : null
    spoke.add(botId)
    budget.left -= 1
    setActivity(roomId, { speaking: [...(store.inspect((state) => getRoom(state, roomId)?.activity?.speaking) ?? []), bot.name] })
    if (driveSession) beginStream(driveSession, bot.name, roomId)
    const controller = new AbortController()
    aborts.set(roomId, controller)
    try {
      const roomNow = roomOrFail(roomId)
      const prompt = buildPrompt({ room: roomNow, bot, at, viewerPeer: remote ? bot.origin?.peer ?? null : null })
      const facts = promptFactsFor({ room: roomNow, bot, at })
      // 本机授权：这句话是别的机器上的人/agent 引出来的，那就先问本机的人。
      // 本机的人自己 @、自己点重试、自己点全员轮次都不问 —— 否则每句都要点一次。
      if (!remote && gate && trigger?.kind === 'lan') {
        setActivity(roomId, { awaiting: bot.name })
        let verdict
        try {
          verdict = await gate.check({
            roomId,
            roomName: roomNow.name,
            agentName: bot.name,
            prompt,
            from: trigger,
            signal: controller.signal,
          })
        } finally {
          setActivity(roomId, { awaiting: null })
        }
        if (!verdict.ok) {
          if (verdict.reason === 'cancelled' || verdict.reason === 'closed') return
          // 只读 / 拒绝 / 超时：屋里留一条说明（notice），不是失败占位 ——
          // 模型没坏、网络没坏，是这台机器没授权。
          postDecline(roomId, botId, bot.name, verdict.reason)
          return
        }
      }
      let text
      if (remote) {
        if (typeof dispatchRemote !== 'function') {
          fail('lan_unavailable', '这台机器没有连上局域网，无法请远程 agent 发言。')
        }
        const result = await withAbort(
          dispatchRemote({ roomId, member: bot, prompt, facts, from: trigger, signal: controller.signal }),
          controller.signal,
        )
        text = result?.text
      } else if (external) {
        text = (
          await runner.say(
            { id: speakerBot.id, sessionId: speakerBot.sessionId, cwd: speakerBot.cwd ?? undefined, external: true },
            prompt,
            { signal: controller.signal, waitIdleFirst: true },
          )
        ).text
      } else {
        text = (await runner.say({ ...speakerBot, cwd: speakerBot.cwd ?? undefined }, prompt, { signal: controller.signal })).text
      }
      complete(roomId, directoryBot, botId, text)
      const fresh = roomOrFail(roomId)
      const created = fresh.messages.at(-1)
      // 这条回复里 @ 了谁：决定要不要继续接力。
      const targets = mentionedBots(fresh, created)
      if (depth < fresh.rules.maxDepth && budget.left > 0) {
        for (const target of targets) {
          if (budget.left <= 0) {
            if (stall) stall.budget = true
            break
          }
          // 这一轮已经被「停下」了：接力也别再往下传。
          if (epochs.get(roomId) !== token) break
          await speakOne({ roomId, botId: target.id, at: 'mention', depth: depth + 1, budget, spoke, token, trigger, stall })
        }
      } else if (targets.length && stall) {
        // 到了接力层数上限：还有 @ 没传下去，界面要能说清是「层数到顶」而不是没人理。
        stall.depth = true
      }
    } catch (error) {
      // 对面的机器自己没过授权那道门：那是它的选择，不是「它坏了」。
      // 落一条说明，而不是红色失败占位 —— 否则重试按钮会一直在，点了也还是不过。
      if (error?.code === 'declined') {
        postDecline(roomId, botId, bot.name, String(error.reason ?? 'denied'))
        return
      }
      log('bot_turn_failed', { botId, error })
      const alive = store.inspect((state) => getRoom(state, roomId))
      // 屋子已经没了（被解散、或镜像那边收到解散），或者用户按了「停下这一轮」：
      // 这两种都不是它回不上来。既不该在屋里留一条红色占位，也不该把这个 agent 记成
      // 「上次失败」—— 那会让人以为是自己这边的模型坏了。
      if (!alive || isCancelled(error)) {
        log('turn_abandoned', { roomId, botId, error })
        return
      }
      postTurnFailure(roomId, bot, String(error?.code ?? error?.message ?? error))
    } finally {
      if (driveSession) endStream(driveSession)
      // 只清自己那一个：用户停下之后紧接着开的新一轮有它自己的 controller，
      // 旧回合收尾时不能把新回合的「停」按钮弄哑。
      if (aborts.get(roomId) === controller) aborts.delete(roomId)
      const speaking = store.inspect((state) => getRoom(state, roomId)?.activity?.speaking ?? [])
      const rest = speaking.filter((name) => name !== bot.name)
      if (rest.length) setActivity(roomId, { speaking: rest })
    }
  }

  /**
   * 这一轮失败：落一条「没回上来」占位。
   *
   * 同一个人连续失败（重试又失败、或一轮里被反复派发）只保留一条：一条派发只该有
   * 一份结果。上一条若还是这个人的失败占位，就地改写，不再追加 —— 否则重试几次
   * 就多几条一模一样的东西，看着像出了好几次事。
   */
  function postTurnFailure(roomId, bot, detail) {
    const text = `（${bot.name} 这次没回上来：${String(detail).slice(0, 120)}）`
    store.commit((state) => {
      const room = getRoom(state, roomId)
      const directory = state.bots.find((row) => row.id === bot.botId)
      if (directory) directory.lastError = String(detail).slice(0, 200)
      if (!room) return
      for (let index = room.messages.length - 1; index >= 0; index -= 1) {
        const message = room.messages[index]
        if (message.authorId !== bot.id) continue
        if (message.status === 'error') {
          message.text = text
          message.at = new Date().toISOString()
          return
        }
        break
      }
      postMessage(state, { roomId, authorId: bot.id, text, status: 'error' })
    })
  }

  /**
   * 这一轮被上限截断（回复预算 / 接力层数）：说清是哪一个到顶了。
   * 用 notice —— 它解释「为什么没人再说话」，不是谁的发言，也不进模型上下文。
   */
  function postStallNotice(roomId, stall, cap, token) {
    if (!stall.budget && !stall.depth) return
    if (epochs.get(roomId) !== token) return
    const room = store.inspect((state) => getRoom(state, roomId))
    if (!room) return
    const parts = []
    if (stall.budget) parts.push(`本轮已达回复上限（一条消息最多 ${cap} 个 agent）`)
    if (stall.depth) parts.push('接力层数到顶')
    const text = `（${parts.join('，')}：后面还有 agent 没轮到，可以再发一句，或在「规则」里调高上限）`
    store.commit((state) => {
      const row = getRoom(state, roomId)
      if (!row) return
      const author =
        row.members.find((member) => member.id === row.ownerId) ??
        row.members.find((member) => member.kind === 'human')
      if (!author) return
      postMessage(state, { roomId, authorId: author.id, text, status: 'notice' })
    })
  }

  function complete(roomId, directoryBot, memberId, text) {
    store.commit((state) => {
      const room = getRoom(state, roomId)
      if (!room) return
      if (directoryBot) {
        directoryBot.lastSpokeAt = new Date().toISOString()
        if (state.bots.includes(directoryBot)) directoryBot.lastError = null
      }
      // 不传 origin：postMessage 会用发言人自己的 origin，远程 agent 的话不会被标成本机。
      // maxChars 是房间规则，必须真的执行：只写在提示词里，模型会一路写到几千字。
      const max = room.rules.maxChars || 1200
      const raw = String(text ?? '').trim()
      const body = raw.length > max ? raw.slice(0, max) + ' …（超出 ' + max + ' 字上限，已截断）' : raw
      postMessage(state, { roomId, authorId: memberId, text: body })
    })
  }

  /**
   * 收尾：把 room.activity 归零，并且（自然跑完时）接上攒着的人消息。
   *
   * token 只有在「收尾的确实还是当前这一轮」时才动手：用户点过「停下」之后
   * 旧回合才姗姗收尾，不能把已经接手的新回合一起收掉。
   */
  function settle(roomId, { drain = false, token } = {}) {
    if (token !== undefined && epochs.get(roomId) !== token) return
    epochs.delete(roomId)
    setActivity(roomId, null)
    running.delete(roomId)
    if (drain) drainPending(roomId)
  }

  function queuePending(roomId, messageId) {
    const list = pending.get(roomId) ?? []
    if (!list.includes(messageId)) list.push(messageId)
    if (list.length > PENDING_LIMIT) list.splice(0, list.length - PENDING_LIMIT)
    pending.set(roomId, list)
  }

  function takePending(roomId) {
    const list = pending.get(roomId)
    if (!list?.length) return null
    const next = list.shift()
    if (!list.length) pending.delete(roomId)
    return next ?? null
  }

  /** 这一轮结束了，把排在后面的人消息依次接上。 */
  function drainPending(roomId) {
    for (;;) {
      if (running.has(roomId)) return
      const next = takePending(roomId)
      if (!next) return
      try {
        if (start({ roomId, messageId: next })) return
      } catch (error) {
        // 房间被解散之类：这条就没地方可说了，丢掉继续看下一条。
        log('pending_failed', { roomId, error })
      }
    }
  }

  /** 按当前规则决定「这条人消息该谁说话」。没人要说话返回 false。 */
  function start({ roomId, messageId }) {
    const room = roomOrFail(roomId)
    const message = room.messages.find((row) => row.id === messageId)
    if (!message) return false
    const rules = room.rules
    const queue = []
    const push = (member) => {
      if (member && member.kind === 'bot' && !queue.some((row) => row.id === member.id)) queue.push(member)
    }
    const directed = message.mentions.length > 0
    if (directed) {
      // 明确点名时只叫被点名的人；主持人和全员规则不额外插入成员。
      if (rules.mention) for (const member of mentionedBots(room, message)) push(member)
    } else {
      if (rules.chairId) push(getMember(room, rules.chairId))
      if (rules.roundRobin) for (const member of botsOf(room)) push(member)
    }
    if (!queue.length) return false
    const now = Date.now()
    const recent = dispatched.get(roomId) ?? new Map()
    for (const [key, at] of recent) if (now - at > DISPATCH_TTL) recent.delete(key)
    const fresh = queue.filter((member) => !recent.has(message.id + '|' + member.id))
    if (!fresh.length) {
      log('duplicate_dispatch_skipped', { roomId, messageId: message.id })
      return false
    }
    for (const member of fresh) recent.set(message.id + '|' + member.id, now)
    dispatched.set(roomId, recent)
    run(roomId, fresh, {
      kind: !directed && rules.chairId && fresh[0]?.id === rules.chairId ? 'chair' : 'mention',
      // 这条人消息是从哪台机器来的：别的机器来的话，本机 agent 的回合要先过授权门。
      trigger: triggerOf(message),
    })
    return true
  }

  /**
   * 一条人消息进来后，按当前规则决定谁说话。
   * 不 await：房间面板先看到人那条，agent 的回复随 watch 一帧一帧出现。
   */
  /**
   * 自动讨论到顶还没结论：在屋里 @ 房主（人）请拍板，然后停手。
   *
   * 为什么要留这一条而不是静默停住：两个 agent 各说各的、谁也不服谁的时候，
   * 屋里看起来「还在聊」，实际在原地转圈。人不主动看就永远不知道它卡住了。
   * 一条明确点名房主的消息，既把人叫来，也给这段讨论一个结束点。
   */
  function escalate(roomId, message, limit) {
    const room = roomOrFail(roomId)
    const owner =
      room.members.find((member) => member.id === room.ownerId) ??
      room.members.find((member) => member.kind === 'human') ??
      null
    const who = owner ? '@' + owner.name : '@房主'
    const text =
      '（自动讨论已达 ' + limit + ' 轮上限，先停在这里；这只是轮次到了，不代表谁对谁错）' +
      who + ' 要继续聊，还是按某个方案走，你定。'
    store.commit((draft) => {
      const row = getRoom(draft, roomId)
      if (!row) return
      const author = row.members.find((member) => member.id === message.authorId) ? message.authorId : row.ownerId
      // 这是系统的提醒，不是谁说过的话：用 notice，不进给模型看的对话记录 ——
      // 否则下一轮模型会把「轮次到顶」当成那个 agent 刚说过的一句，接着往下演。
      postMessage(draft, { roomId, authorId: author, text, status: 'notice' })
    })
    log('auto_round_escalated', { roomId, limit })
  }

  function afterHumanMessage({ roomId, messageId }) {
    const room = roomOrFail(roomId)
    const message = room.messages.find((row) => row.id === messageId)
    // 人说话清零自动回合计数；agent 说话才累加，到顶就 @ 房主拍板并停手。
    if (!message || message.authorKind === 'human') {
      autoRounds.delete(roomId)
      escalated.delete(roomId)
    } else {
      const limit = Math.max(1, Math.min(10, Number(room.rules.maxAutoRounds) || 3))
      const count = autoRounds.get(roomId) ?? 0
      if (count >= limit) {
        if (!escalated.has(roomId)) {
          escalated.add(roomId)
          escalate(roomId, message, limit)
        } else {
          log('auto_round_capped', { roomId, count })
        }
        return
      }
      autoRounds.set(roomId, count + 1)
    }
    if (running.has(roomId)) {
      // 别把用户插进来的话吞掉：攒着，等这一轮跑完再按规则处理。
      queuePending(roomId, messageId)
      return
    }
    if (!start({ roomId, messageId })) drainPending(roomId)
  }

  /** 「让全员说一轮」：不看 @，所有 agent 依次各说一句。 */
  function runRound({ roomId }) {
    const room = roomOrFail(roomId)
    const queue = botsOf(room)
    if (!queue.length) fail('no_agents')
    // 人手点的：本机的人已经用这个动作表达过意图，不再问一次。
    return run(roomId, queue, { kind: 'round', trigger: { kind: 'local', name: null, machine: null, authorKind: 'human' } }, true)
  }

  /** 某条 agent 回复失败后重来一次 —— 只重跑那一个 agent，不惊动别人。 */
  function retryBot({ roomId, memberId }) {
    const room = roomOrFail(roomId)
    const member = getMember(room, memberId)
    if (!member || member.kind !== 'bot') fail('not_agent_message')
    // 同上：重试是本机的人点的，不是远程指挥。
    return run(roomId, [member], { kind: 'round', trigger: { kind: 'local', name: null, machine: null, authorKind: 'human' } }, true)
  }

  function run(roomId, queue, { kind, trigger = null }, awaitIt = false) {
    if (running.has(roomId)) fail('room_busy', '这间屋子正在发言，等这一轮结束。')
    const cap = Math.max(1, roomOrFail(roomId).rules.maxSpeakers)
    const budget = { left: cap }
    // 这一轮被上限截断了吗：给界面一句能看懂的解释，而不是「突然没人说话了」。
    const stall = { budget: false, depth: false }
    const token = Symbol('round')
    const spoke = new Set()
    running.add(roomId)
    epochs.set(roomId, token)
    setActivity(roomId, { speaking: [], awaiting: null, kind, startedAt: new Date().toISOString() })
    const task = (async () => {
      try {
        for (const [index, member] of queue.entries()) {
          if (budget.left <= 0) {
            if (index < queue.length) stall.budget = true
            break
          }
          // 「停下这一轮」是停整轮，不是只停当前这个：epoch 不在了就别再叫下一个人。
          if (epochs.get(roomId) !== token) break
          await speakOne({
            roomId,
            botId: member.id,
            at: index === 0 ? kind : 'round',
            depth: 0,
            budget,
            spoke,
            token,
            trigger,
            stall,
          })
        }
        postStallNotice(roomId, stall, cap, token)
      } finally {
        settle(roomId, { drain: true, token })
      }
    })().catch((error) => {
      // 收尾交给上面的 finally：这里只管把错误记下来，别再把可能已经接手的新回合收一遍。
      log('round_failed', { roomId, error })
    })
    return awaitIt ? task : task
  }

  function stop(roomId) {
    // 用户点了「停下」，那就连攒着的那几句也一起放下 —— 不然一停就立刻又开一轮。
    pending.delete(roomId)
    aborts.get(roomId)?.abort()
    settle(roomId)
  }

  /** 房间被清空时用：停掉这一轮、丢掉排队与自动讨论的计数，一切从头开始。 */
  function forget(roomId) {
    pending.delete(roomId)
    autoRounds.delete(roomId)
    escalated.delete(roomId)
    stop(roomId)
  }

  return {
    afterHumanMessage, runRound, retryBot, stop, buildPrompt, forget, beginStream, pushStream, endStream,
    buildFacts: (args) => promptFactsFor(args),
    promptFromFacts,
  }
}
