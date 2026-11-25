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

function buildPrompt({ room, bot, at }) {
  const memberLine = room.members
    .map((member) => {
      const kind = member.kind === 'human' ? '人' : 'agent'
      // 说「从哪台机器来」而不是那条连接的 peer 地址：peer 是进程现发的（重启就变），
      // 机器名才是这个模型能记住、人能对上号的东西。
      const where = member.origin?.kind === 'lan' ? `，从 LAN 进来（${member.origin.machine || member.origin.peer || '远程'}）` : '，本机'
      const role = member.role ? `，${member.role}` : ''
      return `- ${member.name}（${kind}${role}${where}）`
    })
    .join('\n')
  const transcript = transcriptOf(room, { limit: 24 })
  const rules = []
  if (room.rules.mention) rules.push('被 @ 时回话')
  if (room.rules.roundRobin) rules.push('轮到全员时各说一句')
  if (room.rules.chairId) {
    const chair = getMember(room, room.rules.chairId)
    if (chair) rules.push(`主持人是 ${chair.name}`)
  }
  return [
    `你正在 DeepSeek Harness 的一间群聊房间里，以「${bot.name}」的身份参与对话。`,
    bot.role ? `你的职责：${bot.role}` : '',
    '',
    `房间：${room.name}${room.topic ? `\n主题：${room.topic}` : ''}`,
    '成员：',
    memberLine,
    '',
    rules.length ? `房间规则：${rules.join('；')}` : '',
    '',
    '最近的对话（#序号 作者：内容）：',
    transcript || '（还没有人说话）',
    '',
    at === 'chair'
      ? '现在轮到你这个主持人发言：先把大家的分歧点出来，给出你的判断；需要谁补充，就在话里 @ 他的名字。'
      : at === 'round'
        ? '现在轮到你发言：就上面的话题说你自己的看法，可以顺着别人的话补充或反驳。'
        : '现在轮到你了：回应上面提到你或与你有关的内容。',
    `要求：中文；不超过 ${room.rules.maxChars} 字；只输出你要说的那段话本身，不要前缀、不要解释、不要「作为 X」这类元信息。`,
  ]
    .filter((line) => line !== '')
    .join('\n')
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
  const autoRounds = new Map()
  const MAX_AUTO_ROUNDS = 2

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

  async function speakOne({ roomId, botId, at, depth, budget, spoke, token, trigger = null }) {
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
    // 外部成员有两副样子：本机房间里是一条只带 sessionId 的成员行（没有目录行）；
    // 局域网房间里是报给宿主的一个 agent，本机 state.bots 里有目录行但 external=true。
    // 两种都代表「用户正在用的那个会话」，都必须先等空闲再递话。
    const external = !remote && (isExternalMember(bot) || directoryBot?.external === true)
    if (!remote && !external && !directoryBot) {
      log('bot_missing', botId)
      return
    }
    spoke.add(botId)
    budget.left -= 1
    setActivity(roomId, { speaking: [...(store.inspect((state) => getRoom(state, roomId)?.activity?.speaking) ?? []), bot.name] })
    const controller = new AbortController()
    aborts.set(roomId, controller)
    try {
      const roomNow = roomOrFail(roomId)
      const prompt = buildPrompt({ room: roomNow, bot, at })
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
          dispatchRemote({ roomId, member: bot, prompt, from: trigger, signal: controller.signal }),
          controller.signal,
        )
        text = result?.text
      } else if (external) {
        // 有目录行时以它为准（id / sessionId / cwd 都在它身上）；否则就是成员行自己。
        const speakerBot = directoryBot?.external === true ? directoryBot : bot
        text = (
          await runner.say(
            { id: speakerBot.id, sessionId: speakerBot.sessionId, cwd: speakerBot.cwd ?? undefined, external: true },
            prompt,
            { signal: controller.signal, waitIdleFirst: true },
          )
        ).text
      } else {
        text = (await runner.say({ ...directoryBot, cwd: directoryBot.cwd ?? undefined }, prompt, { signal: controller.signal })).text
      }
      complete(roomId, directoryBot, botId, text)
      const fresh = roomOrFail(roomId)
      const created = fresh.messages.at(-1)
      if (depth < fresh.rules.maxDepth && budget.left > 0) {
        for (const target of mentionedBots(fresh, created)) {
          if (budget.left <= 0) break
          // 这一轮已经被「停下」了：接力也别再往下传。
          if (epochs.get(roomId) !== token) break
          await speakOne({ roomId, botId: target.id, at: 'mention', depth: depth + 1, budget, spoke, token, trigger })
        }
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
      store.commit((state) => {
        const room = getRoom(state, roomId)
        const directory = state.bots.find((row) => row.id === bot.botId)
        if (directory) directory.lastError = String(error?.code ?? error?.message ?? error).slice(0, 200)
        if (!room) return
        postMessage(state, {
          roomId,
          authorId: botId,
          text: `（${bot.name} 这次没回上来：${String(error?.code ?? error?.message ?? error).slice(0, 120)}）`,
          status: 'error',
        })
      })
    } finally {
      // 只清自己那一个：用户停下之后紧接着开的新一轮有它自己的 controller，
      // 旧回合收尾时不能把新回合的「停」按钮弄哑。
      if (aborts.get(roomId) === controller) aborts.delete(roomId)
      const speaking = store.inspect((state) => getRoom(state, roomId)?.activity?.speaking ?? [])
      const rest = speaking.filter((name) => name !== bot.name)
      if (rest.length) setActivity(roomId, { speaking: rest })
    }
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
      postMessage(state, { roomId, authorId: memberId, text })
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
    if (rules.chairId) push(getMember(room, rules.chairId))
    if (rules.mention) for (const member of mentionedBots(room, message)) push(member)
    if (rules.roundRobin) for (const member of botsOf(room)) push(member)
    if (!queue.length) return false
    run(roomId, queue, {
      kind: rules.chairId && queue[0]?.id === rules.chairId ? 'chair' : 'mention',
      // 这条人消息是从哪台机器来的：别的机器来的话，本机 agent 的回合要先过授权门。
      trigger: triggerOf(message),
    })
    return true
  }

  /**
   * 一条人消息进来后，按当前规则决定谁说话。
   * 不 await：房间面板先看到人那条，agent 的回复随 watch 一帧一帧出现。
   */
  function afterHumanMessage({ roomId, messageId }) {
    const room = roomOrFail(roomId)
    const message = room.messages.find((row) => row.id === messageId)
    // 人说话清零自动回合计数；agent 说话才累加，到顶就不再自动开新一轮。
    if (!message || message.authorKind === 'human') {
      autoRounds.delete(roomId)
    } else {
      const count = autoRounds.get(roomId) ?? 0
      if (count >= MAX_AUTO_ROUNDS) {
        log('auto_round_capped', { roomId, count })
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
    const budget = { left: Math.max(1, roomOrFail(roomId).rules.maxSpeakers) }
    const token = Symbol('round')
    const spoke = new Set()
    running.add(roomId)
    epochs.set(roomId, token)
    setActivity(roomId, { speaking: [], awaiting: null, kind, startedAt: new Date().toISOString() })
    const task = (async () => {
      try {
        for (const [index, member] of queue.entries()) {
          if (budget.left <= 0) break
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
          })
        }
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

  return { afterHumanMessage, runRound, retryBot, stop, buildPrompt }
}
