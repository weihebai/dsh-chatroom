import { randomUUID } from 'node:crypto'
import { clearMessages, postMessage, removeMember, rotateSession } from './rooms.js'
import { pageMessages } from './project.js'

/**
 * 会话侧的聊天室工具：让正在跟你对话的这个 AI 能自己去群里喊人、报进度。
 *
 * 一条原则：**工具不登记成员**。它只能以「你在这间屋里已经创建好的某个 agent」的身份发言；
 * 名字由 as 指定，找不到就报错并列出可以用的名字，绝不悄悄新建一个成员。
 * 想清除以前留下的“会话成员”，用 action=leave。
 *
 * 两种房间，两条写路径：
 *   本机房间：真源就在这台机器上，直接落库。
 *   镜像房间（加入了别人的屋子）：真源在对面，消息走 /lan/message，用 authorBotId 署名；
 *            宿主只认「这条连接名下」的 agent。
 */

const fail = (code, message) => {
  throw Object.assign(new Error(message ?? code), { code })
}

const TOOL_NAME = 'chatroom'

const TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'send', 'ask', 'notify', 'read', 'leave', 'clear', 'session'],
      description:
        'list 看房间与成员（标明本机 / LAN 加入）；send 以你本机创建好的某个 agent 身份发消息并 @ 人；notify 发一条不 @ 任何人的通知；read 读最近的对话；leave 把这个会话此前登记的成员身份从房间移除。',
    },
    room: { type: 'string', description: '房间名、房间码或 roomId。只有一间屋子时可以省略。' },
    as: { type: 'string', description: '用哪个成员的身份发言：必须是这间屋里你本机已经创建好的 agent 名字（比如「backend-dev」）。只有唯一一个本机 agent 时可以省略。' },
    bind: { type: 'boolean', description: '发送时是否把这个成员绑定到当前会话，默认 true。绑定后房间里 @ 它会回到这个会话继续（上下文就是你现在的项目），而不是回到它早先自己开的旧会话；传 false 只发不绑。' },
    to: { type: 'array', items: { type: 'string' }, description: '要 @ 的成员名字列表（send 用）。' },
    text: { type: 'string', description: '消息正文。send / notify 必填。' },
    limit: { type: 'integer', description: 'read 返回多少条，默认 20，最多 200。' },
    beforeSeq: { type: 'integer', description: 'read 用：从这一条（不含）往前翻，取更早的一页。返回里会告诉你还有没有更早的。' },
    mode: { type: 'string', enum: ['new', 'continue', 'status', 'unbind'], description: '仅作用于所选房间：new 开新会话，continue 回上一个会话，status 查看绑定，unbind 解除绑定改用 agent 默认会话；其他房间不变。' },
    timeoutSec: { type: 'integer', description: 'ask 用：可选。给了就等它回这么久（1..180 秒）；不给就发完立即返回、不等（整轮可能要几分钟，用 read 查结果更稳）。' },
  },
  required: ['action'],
}

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { message: { type: 'string' } },
  required: ['message'],
}

const clip = (value, max) => String(value ?? '').slice(0, max)

function whereOf(member) {
  if (member.origin && member.origin.kind === 'lan') {
    return 'LAN·' + (member.origin.machine || member.origin.peer || '远程')
  }
  return '本机'
}

function memberLine(member, sessionId) {
  const kind = member.kind === 'human' ? '人' : member.external === true && !member.botId ? 'agent·会话登记' : 'agent'
  const role = member.role ? '，' + member.role : ''
  const self = member.sessionId && member.sessionId === sessionId ? ' ← 你当前会话' : ''
  const bound = member.sessionBound === true ? ' · 本房间会话=' + member.sessionId : ''
  return '- ' + member.name + '（' + kind + role + '，' + whereOf(member) + '）' + bound + self
}

function resolveRoom(state, key) {
  const wanted = clip(key, 120).trim()
  if (!wanted) {
    if (state.rooms.length === 1) return state.rooms[0]
    if (state.rooms.length === 0) fail('room_not_found', '现在还没有任何房间。')
    fail('room_ambiguous', '有好几间屋子，请用 room 指定房间名或房间码。')
  }
  const lower = wanted.toLowerCase()
  const hit =
    state.rooms.find((room) => room.id === wanted) ??
    state.rooms.find((room) => String(room.code).toLowerCase() === lower) ??
    state.rooms.find((room) => room.name === wanted)
  if (!hit) fail('room_not_found', '找不到房间「' + wanted + '」。')
  return hit
}

/** 这台机器创建、可以在屋里代表你发言的 agent：本机来源、不是「会话登记」那种。 */
function localAgentsOf(room) {
  return room.members.filter((member) => {
    if (member.kind !== 'bot') return false
    if (member.external === true && !member.botId) return false
    return (member.origin && member.origin.kind === 'lan') !== true
  })
}

function pickSpeaker(room, name) {
  const candidates = localAgentsOf(room)
  const wanted = clip(name, 60).trim()
  if (wanted) {
    const hit = candidates.find((member) => member.name === wanted)
    if (hit) return hit
    fail(
      'member_not_found',
      '这间屋里没有你本机创建的名叫「' + wanted + '」的 agent。可以用的：' +
        (candidates.map((member) => member.name).join('、') || '（没有，先去面板加一个）') +
        '。',
    )
  }
  if (candidates.length === 1) return candidates[0]
  if (!candidates.length) fail('no_local_agent', '这间屋里没有你本机创建的 agent。先在面板里加一个，再用它的名字发言。')
  fail(
    'member_required',
    '这间屋里有多个本机 agent，请用 as 指定用哪个身份发言：' + candidates.map((member) => member.name).join('、') + '。',
  )
}

function withMentions(text, names) {
  const body = String(text ?? '')
  const missing = names.filter((name) => !body.includes('@' + name))
  if (!missing.length) return body
  return (missing.map((name) => '@' + name).join(' ') + ' ' + body).trim()
}

/**
 * 把「这个成员」绑定到当前会话。
 *
 * 为什么需要：一只 agent 早先被驱动过一次，就已经有了自己的会话；之后房间再 @ 它，
 * 默认会 resume 那个旧会话 —— 而那个会话的工作目录、上下文都不是你现在用的项目，
 * 讨论自然对不上。绑定只更新当前房间的成员会话，不改 agent 默认会话或其他房间，
 * 于是 speak/turn 走「先等空闲再递话」那条路，@ 回来直接落在你现在这个会话里。
 */
function bindSpeaker(store, room, member, sessionId) {
  if (!room || !member || !member.botId || !sessionId) return
  store.commit((draft) => {
    const row = draft.rooms.find((item) => item.id === room.id)?.members.find((item) => item.id === member.id)
    if (!row) return
    // 绑定只属于这个房间，不改共享 agent 的默认会话。
    if (row.sessionId !== sessionId) {
      row.previousSessionId = row.sessionId ?? null
      row.previousExternal = row.external === true
      row.previousSessionBound = row.sessionBound === true
    }
    row.sessionId = sessionId
    row.sessionBound = true
    row.external = true
    row.lastSpokeAt = null
  })
}

/** ask 的超时：默认 90 秒，夹在 5..180。 */
function askTimeout(value) {
  const secs = Number(value)
  const safe = Number.isFinite(secs) && secs > 0 ? secs : 90
  return Math.min(180, Math.max(1, Math.round(safe))) * 1000
}

/**
 * 等某个成员在房间里回一句话。
 *
 * 为什么轮询而不是挂监听：工具本身就在这一轮里，能用的只有 store 的当前状态；
 * 目标 agent 的回复是另一个进程/会话异步补进来的，按 250ms 看一次最简单也最稳。
 */
async function waitForReply({ store, roomId, targetId, afterSeq, timeoutMs }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const room = store.state.rooms.find((row) => row.id === roomId)
    if (!room) return null
    const hit = room.messages.find((message) => message.seq > afterSeq && message.authorId === targetId)
    if (hit) return hit
    if (Date.now() > deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

function replyMessage(target, reply, timeoutSec) {
  if (!reply) {
    const secs = Math.round(askTimeout(timeoutSec) / 1000)
    return '「' + target.name + '」在 ' + secs + ' 秒内没有回复（可能它没被驱动、或那台机器没在跑）。消息已经发进房间了。'
  }
  if (reply.status === 'error') return '「' + target.name + '」这次没回上来：' + reply.text
  if (reply.status === 'notice') return '「' + target.name + '」没有执行：' + reply.text
  return '「' + target.name + '」回复：' + reply.text
}

function lanOf(runtime) {
  const lan = runtime.lan
  if (!lan || typeof lan.send !== 'function') {
    fail('lan_unavailable', '这台机器没有连上这间屋子的宿主，发不出去。')
  }
  return lan
}

export function createChatroomTool(runtime, { log = () => {} } = {}) {
  async function execute(args, exec) {
    const input = args && typeof args === 'object' ? args : {}
    const action = typeof input.action === 'string' ? input.action : 'list'
    const store = runtime.store
    if (!store) fail('not_ready', '聊天室插件还没准备好，稍后再试。')
    const state = store.state
    const sessionId = exec?.agent?.id ?? ''

    if (action === 'list') {
      if (!state.rooms.length) return { message: '现在还没有房间。' }
      const rows = state.rooms.map((room) => {
        const head =
          '# ' + room.name + '（房间码 ' + room.code + (room.remote ? '，在别的机器上' : '') + '）' +
          (room.id === state.activeRoomId ? ' · 当前屋子' : '')
        const members = room.members.map((member) => memberLine(member, sessionId)).join('\n')
        return head + '\n' + members
      })
      return { message: '房间列表：\n' + rows.join('\n\n') }
    }

    const room = resolveRoom(state, input.room ?? input.roomId)
    const body = clip(input.text, 8000).trim()
    const names = Array.isArray(input.to) ? input.to.map((name) => clip(name, 60).trim()).filter(Boolean) : []

    if (action === 'leave') {
      const targets = []
      for (const row of state.rooms) {
        for (const member of row.members) {
          if (member.external === true && !member.botId && sessionId && member.sessionId === sessionId) {
            targets.push({ roomId: row.id, memberId: member.id, roomName: row.name })
          }
        }
      }
      if (!targets.length) return { message: '这个会话目前没有以成员身份登记在任何房间里。' }
      store.commit((draft) => {
        for (const target of targets) removeMember(draft, { roomId: target.roomId, memberId: target.memberId })
      })
      return { message: '已把这个会话的成员身份从 ' + targets.length + ' 个房间移除：' + targets.map((t) => t.roomName).join('、') + '。' }
    }

    if (action === 'clear') {
      if (room.remote) fail('remote_room', '这间屋子在别的机器上，清空要在那台机器上做。')
      store.commit((draft) => clearMessages(draft, { roomId: room.id }))
      runtime.speaker?.forget?.(room.id)
      return { message: '已清空「' + room.name + '」的聊天记录（成员和规则保留）。' }
    }

    if (action === 'session') {
      const member = pickSpeaker(room, input.as)
      const bot = store.state.bots.find((row) => row.id === member.botId)
      if (!bot) fail('bot_not_found', '这个成员没有对应的 agent，无法切会话。')
      const mode = String(input.mode ?? 'new').trim()
      if (!['new', 'continue', 'status', 'unbind'].includes(mode)) {
        fail('bad_session_mode', 'session 的 mode 只能是 new、continue、status 或 unbind。')
      }
      if (mode === 'status') {
        return {
          message:
            '「' + room.name + '」的「' + member.name + '」' +
            (member.sessionBound ? '已绑定房间会话：' + member.sessionId : '使用 agent 默认会话：' + bot.sessionId),
        }
      }
      let changed = false
      store.commit((draft) => {
        const row = draft.rooms.find((item) => item.id === room.id)?.members.find((item) => item.id === member.id)
        const live = draft.bots.find((item) => item.id === member.botId)
        changed = rotateSession(row, live, mode)
      })
      if (!changed) fail('no_previous_session', '「' + member.name + '」在「' + room.name + '」没有上一个会话可以回。')
      const said = {
        new: '已让「' + member.name + '」在「' + room.name + '」开了一个新会话：只影响这个房间，其他房间不变。',
        continue: '已让「' + member.name + '」在「' + room.name + '」回到上一个会话继续；其他房间不受影响。',
        unbind: '已解除「' + room.name + '」中「' + member.name + '」的会话绑定；改用 agent 默认会话，其他房间不变。',
      }
      return { message: said[mode] }
    }

    if (action === 'ask') {
      if (!body) fail('message_empty', 'ask 需要 text。')
      const targetName = names[0]
      if (!targetName) fail('target_required', 'ask 需要 to：要先 @ 一个房间成员。')
      const target = room.members.find((row) => row.name === targetName)
      if (!target) fail('member_not_found', '这间屋里没有叫「' + targetName + '」的成员。')
      // 不能问一个绑在自己身上的会话：那等于等自己，永远等不到。
      const targetBot = target.botId ? store.state.bots.find((row) => row.id === target.botId) : null
      const targetSessionId = target.sessionBound ? target.sessionId : targetBot?.sessionId
      if (targetSessionId && targetSessionId === sessionId && (!target.origin || target.origin.kind !== 'lan')) {
        fail('self_target', '「' + target.name + '」就是当前会话自己绑定的身份，不能 @ 自己等回复。')
      }
      const speaker = pickSpeaker(room, input.as)
      if (input.bind !== false) bindSpeaker(store, room, speaker, sessionId)
      if (target.id === speaker.id) fail('self_target', '你要 @ 的就是你自己的身份（' + speaker.name + '），换个成员再问。')
      // 不给 timeoutSec 就发完即回（整轮可能要几分钟，别把会话卡死）。
      const waitMs = input.timeoutSec === undefined ? 0 : askTimeout(input.timeoutSec)
      if (room.remote) {
        const lan = lanOf(runtime)
        await lan.announceAgents?.()
        await lan.send({ roomId: room.id, text: withMentions(body, [target.name]), mentions: [target.name], authorBotId: speaker.botId })
        if (!waitMs) return { message: '已把消息发给「' + target.name + '」（@ 了它）。这条不等回复；要看结果就让我 read 一下房间，或加 timeoutSec 让我等。' }
        const reply = await waitForReply({ store, roomId: room.id, targetId: target.id, afterSeq: room.nextSeq - 1, timeoutMs: waitMs })
        return { message: replyMessage(target, reply, input.timeoutSec) }
      }
      if (!runtime.speaker) fail('not_ready', '聊天室插件还没准备好，稍后再试。')
      let posted = null
      store.commit((draft) => {
        posted = postMessage(draft, {
          roomId: room.id,
          authorId: speaker.id,
          text: withMentions(body, [target.name]),
          mentions: [target.id],
          origin: { kind: 'local' },
        })
      })
      runtime.speaker.afterHumanMessage({ roomId: room.id, messageId: posted.id })
      if (!waitMs) return { message: '已把消息发给「' + target.name + '」（@ 了它）。这条不等回复；要看结果就让我 read 一下房间，或加 timeoutSec 让我等。' }
      const reply = await waitForReply({ store, roomId: room.id, targetId: target.id, afterSeq: posted.seq, timeoutMs: waitMs })
      return { message: replyMessage(target, reply, input.timeoutSec) }
    }

    if (action === 'read') {
      const limit = Math.max(1, Math.min(200, Number(input.limit) || 20))
      const beforeSeq = Number.isFinite(Number(input.beforeSeq)) ? Number(input.beforeSeq) : undefined
      let page
      if (room.remote) {
        page = await lanOf(runtime).page({ roomId: room.id, beforeSeq, limit })
      } else {
        page = pageMessages(room, { beforeSeq, limit })
      }
      const rows = (page.messages ?? []).filter((m) => m.status !== 'error' && m.status !== 'notice')
      if (!rows.length) return { message: '「' + room.name + '」这个位置没有更多消息了。' }
      const total = typeof page.total === 'number' ? page.total : room.messages.length
      const head =
        '「' + room.name + '」消息 ' + rows[0].seq + '–' + rows[rows.length - 1].seq + '（共 ' + total + ' 条）' +
        (page.hasMore ? '，还有更早的：read 时带上 beforeSeq=' + rows[0].seq : '，已经到头了')
      const bodyText = rows.map((m) => '#' + m.seq + ' ' + m.authorName + '：' + m.text).join('\n')
      return { message: head + '\n' + bodyText }
    }

    if (action === 'notify') {
      if (!body) fail('message_empty', 'notify 需要 text。')
      const speaker = pickSpeaker(room, input.as)
      if (input.bind !== false) bindSpeaker(store, room, speaker, sessionId)
      if (room.remote) {
        const lan = lanOf(runtime)
        await lan.announceAgents?.()
        await lan.send({ roomId: room.id, text: body, silent: true, authorBotId: speaker.botId })
        return { message: '已在「' + room.name + '」以「' + speaker.name + '」发出通知（不 @ 人，没有触发任何 agent）。' }
      }
      store.commit((draft) => {
        postMessage(draft, { roomId: room.id, authorId: speaker.id, text: body, origin: { kind: 'local' } })
      })
      return { message: '已在「' + room.name + '」以「' + speaker.name + '」发出通知（不 @ 人，没有触发任何 agent）。' }
    }

    if (action === 'send') {
      if (!body) fail('message_empty', 'send 需要 text。')
      const speaker = pickSpeaker(room, input.as)
      if (input.bind !== false) bindSpeaker(store, room, speaker, sessionId)
      const others = names.filter((name) => name !== speaker.name)
      if (room.remote) {
        const lan = lanOf(runtime)
        await lan.announceAgents?.()
        await lan.send({ roomId: room.id, text: withMentions(body, others), mentions: others, authorBotId: speaker.botId })
        log('tool_send_lan', { roomId: room.id, botId: speaker.botId, targets: others.length })
        return {
          message:
            '已在「' + room.name + '」以「' + speaker.name + '」发出，@ 了 ' + (others.join('、') || '（没有人）') + '。' +
            '被 @ 的 agent 会在它自己的会话里开始处理；这条不会等它回复。',
        }
      }
      const targets = others.map((name) => room.members.find((row) => row.name === name)).filter(Boolean)
      const unknown = others.filter((name) => !room.members.some((row) => row.name === name))
      const text = withMentions(body, targets.map((row) => row.name))
      let posted = null
      store.commit((draft) => {
        posted = postMessage(draft, {
          roomId: room.id,
          authorId: speaker.id,
          text,
          mentions: targets.map((row) => row.id),
          origin: { kind: 'local' },
        })
      })
      if (targets.length && runtime.speaker) runtime.speaker.afterHumanMessage({ roomId: room.id, messageId: posted.id })
      log('tool_send', { roomId: room.id, memberId: speaker.id, targets: targets.length })
      return {
        message:
          '已在「' + room.name + '」以「' + speaker.name + '」发出，@ 了 ' + (targets.map((row) => row.name).join('、') || '（没有人）') + '。' +
          (targets.length ? '被 @ 的 agent 会在自己的会话里开始处理；这条不会等它回复。' : '这条没有触发任何 agent。') +
          (unknown.length ? ' 找不到成员：' + unknown.join('、') + '。' : ''),
      }
    }

    fail('unknown_action', '不认识的动作：' + action)
  }

  return {
    name: TOOL_NAME,
    description:
      '在 DeepSeek Harness 的群聊房间里发言。**工具不新建成员**：只能用你在这间屋里已经创建好的某个 agent 身份发言，名字由 as 指定（只有一个本机 agent 时可省略），找不到就报错并列出可用的名字。send：以该身份发消息并 @ 指定成员，被 @ 的 agent 会在它自己的会话里开始干活，这条不等它回复；ask：@ 一个成员并等它回一句，把回复直接返回给你（私聊式对话，默认等 90 秒）；notify：发一条不 @ 任何人的通知，只给人看；read：读最近的对话，带 beforeSeq 可以往前翻页；list：看房间与成员（标明本机 / LAN 加入）；leave：把这个会话此前登记的成员身份移除；clear：清空这间屋的聊天记录（成员和规则保留）；session：mode=new 给某个 agent 开新会话（旧上下文不带入），mode=continue 回到上一个会话。发送默认只绑定当前房间成员到当前会话，不改 agent 默认会话或其他房间。session mode=status 查看绑定，mode=unbind 解除本房间绑定；bind:false 只发不绑。',
    parameters: TOOL_PARAMETERS,
    output: { schema: TOOL_OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: value.message }] },
    execute,
  }
}
