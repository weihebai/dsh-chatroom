import { postMessage, removeMember } from './rooms.js'

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
      enum: ['list', 'send', 'notify', 'read', 'leave'],
      description:
        'list 看房间与成员（标明本机 / LAN 加入）；send 以你本机创建好的某个 agent 身份发消息并 @ 人；notify 发一条不 @ 任何人的通知；read 读最近的对话；leave 把这个会话此前登记的成员身份从房间移除。',
    },
    room: { type: 'string', description: '房间名、房间码或 roomId。只有一间屋子时可以省略。' },
    as: { type: 'string', description: '用哪个成员的身份发言：必须是这间屋里你本机已经创建好的 agent 名字（比如「backend-dev」）。只有唯一一个本机 agent 时可以省略。' },
    bind: { type: 'boolean', description: '发送时是否把这个成员绑定到当前会话，默认 true。绑定后房间里 @ 它会回到这个会话继续（上下文就是你现在的项目），而不是回到它早先自己开的旧会话；传 false 只发不绑。' },
    to: { type: 'array', items: { type: 'string' }, description: '要 @ 的成员名字列表（send 用）。' },
    text: { type: 'string', description: '消息正文。send / notify 必填。' },
    limit: { type: 'integer', description: 'read 返回多少条，默认 20，最多 200。' },
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
  const kind = member.kind === 'human' ? '人' : member.external === true ? 'agent·会话登记' : 'agent'
  const role = member.role ? '，' + member.role : ''
  const self = member.sessionId && member.sessionId === sessionId ? ' ← 你' : ''
  return '- ' + member.name + '（' + kind + role + '，' + whereOf(member) + '）' + self
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
    if (member.external === true) return false
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
 * 讨论自然对不上。绑定把它的 sessionId 换成当前会话，并标记为 external，
 * 于是 speak/turn 走「先等空闲再递话」那条路，@ 回来直接落在你现在这个会话里。
 */
function bindSpeaker(store, member, sessionId) {
  if (!member || !member.botId || !sessionId) return
  store.commit((draft) => {
    const bot = draft.bots.find((row) => row.id === member.botId)
    if (!bot) return
    bot.sessionId = sessionId
    bot.external = true
    bot.lastSpokeAt = null
    for (const room of draft.rooms) {
      for (const row of room.members) {
        if (row.botId === bot.id) row.sessionId = sessionId
      }
    }
  })
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

    if (action === 'leave') {
      const targets = []
      for (const row of state.rooms) {
        for (const member of row.members) {
          if (member.external === true && sessionId && member.sessionId === sessionId) {
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

    if (action === 'read') {
      const limit = Math.max(1, Math.min(200, Number(input.limit) || 20))
      const rows = room.messages
        .filter((message) => message.status !== 'error' && message.status !== 'notice')
        .slice(-limit)
        .map((message) => '#' + message.seq + ' ' + message.authorName + '：' + message.text)
        .join('\n')
      return { message: rows ? '「' + room.name + '」最近的消息：\n' + rows : '「' + room.name + '」还没有人说话。' }
    }

    const body = clip(input.text, 8000).trim()
    const names = Array.isArray(input.to) ? input.to.map((name) => clip(name, 60).trim()).filter(Boolean) : []

    if (action === 'notify') {
      if (!body) fail('message_empty', 'notify 需要 text。')
      const speaker = pickSpeaker(room, input.as)
      if (input.bind !== false) bindSpeaker(store, speaker, sessionId)
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
      if (input.bind !== false) bindSpeaker(store, speaker, sessionId)
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
      '在 DeepSeek Harness 的群聊房间里发言。**工具不新建成员**：只能用你在这间屋里已经创建好的某个 agent 身份发言，名字由 as 指定（只有一个本机 agent 时可省略），找不到就报错并列出可用的名字。send：以该身份发消息并 @ 指定成员，被 @ 的 agent 会在它自己的会话里开始干活，这条不等它回复；notify：发一条不 @ 任何人的通知，只给人看；read：读最近的对话；list：看房间与成员（标明本机 / LAN 加入）；leave：把这个会话此前登记的成员身份移除。发送默认会把用到的成员绑定到当前会话（之后 @ 它会回到这里继续），bind:false 可只发不绑。',
    parameters: TOOL_PARAMETERS,
    output: { schema: TOOL_OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: value.message }] },
    execute,
  }
}
