import { newId, newRoomCode } from './state.js'
import { claimColor, isWhaleColor } from './palette.js'

/**
 * 房间状态机：纯函数，全部直接改传进来的 state。
 *
 * 「纯」在这里很重要 —— 这层是唯一需要认真测的东西：房间、成员、消息序号、
 * 未读游标、三条发言规则。Bot 回合（要真调模型）不在这里，见 turn.js / speak.js。
 */

/** 发言规则默认值。三条规则是并列存在的开关，不是互斥的三选一。 */
export const DEFAULT_RULES = {
  mention: true, // 被 @ 的 agent 一定回
  roundRobin: false, // 人发言后所有 agent 依次各说一句
  chairId: null, // 主持人 memberId：先把话交给它，它可以 @ 别人接力
  maxSpeakers: 3, // 一条人消息最多引出几个 agent 回复（含接力）
  maxDepth: 2, // agent 之间接力的最大层数
  maxChars: 1200, // 单条消息上限
  maxAutoRounds: 3, // agent 之间自动讨论最多几轮，到顶就 @ 房主拍板
}

const LIMITS = { name: 60, topic: 400, role: 200, text: 8000, members: 60, messages: 4000 }

/**
 * 一间屋最多记住几台机器的身份。
 *
 * 走掉的机器回来是「同一个人」，所以要记；但记下的名单不能无限攒 ——
 * 来的都是熟人的局域网，上限 8 台已经比一屋子坐得下的机器多一倍。
 */
const SEAT_LIMIT = 8

const fail = (code, message) => {
  throw Object.assign(new Error(message ?? code), { code })
}

export function clean(value, max) {
  const text = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n/g, '\n')
    .trim()
  if (text.length > max) return text.slice(0, max)
  return text
}

export const getRoom = (state, roomId) => state.rooms.find((room) => room.id === roomId) ?? null

function requireRoom(state, roomId) {
  const room = getRoom(state, roomId)
  if (!room) fail('room_not_found')
  return room
}

export const getMember = (room, memberId) => room.members.find((member) => member.id === memberId) ?? null

/**
 * 开一间屋子。color 是起房间的人自己挑的那一档虎鲸。
 *
 * 为什么颜色从建屋这一步就要定：这间屋里还不存在「我以前是什么颜色」，
 * 没有可继承的东西。调用方没给（脚本、旧客户端）就铺第一档，不让建屋失败。
 */
export function createRoom(state, { name, topic, selfName, color } = {}) {
  const label = clean(name, LIMITS.name)
  if (!label) fail('room_name_required')
  const taken = new Set(state.rooms.map((room) => room.code))
  const room = {
    id: newId('rm'),
    code: newRoomCode(taken),
    name: label,
    topic: clean(topic, LIMITS.topic),
    createdAt: new Date().toISOString(),
    ownerId: state.self.id,
    rules: { ...DEFAULT_RULES },
    members: [],
    messages: [],
    nextSeq: 1,
    reads: {},
  }
  // 起房间的人自动在屋里，身份是「人」。
  room.members.push({
    id: state.self.id,
    kind: 'human',
    name: clean(selfName ?? state.self.name, LIMITS.name) || '我',
    role: '',
    color: claimColor(room, { wanted: color }),
    botId: null,
    sessionId: null,
    owner: 'local',
    origin: { kind: 'local', peer: null, machine: null },
    joinedAt: new Date().toISOString(),
    reach: 'here',
  })
  state.rooms.push(room)
  state.activeRoomId = room.id
  return room
}

export function updateRoom(state, { roomId, name, topic, rules } = {}) {
  const room = requireRoom(state, roomId)
  if (name !== undefined) {
    const label = clean(name, LIMITS.name)
    if (!label) fail('room_name_required')
    room.name = label
  }
  if (topic !== undefined) room.topic = clean(topic, LIMITS.topic)
  if (rules && typeof rules === 'object') {
    if (rules.mention !== undefined) room.rules.mention = Boolean(rules.mention)
    if (rules.roundRobin !== undefined) room.rules.roundRobin = Boolean(rules.roundRobin)
    if (rules.chairId !== undefined) {
      if (rules.chairId === null) room.rules.chairId = null
      else {
        const member = getMember(room, rules.chairId)
        if (!member || member.kind !== 'bot') fail('chair_must_be_agent')
        room.rules.chairId = member.id
      }
    }
    if (rules.maxSpeakers !== undefined) room.rules.maxSpeakers = clampInt(rules.maxSpeakers, 1, 8, room.rules.maxSpeakers)
    if (rules.maxDepth !== undefined) room.rules.maxDepth = clampInt(rules.maxDepth, 0, 3, room.rules.maxDepth)
    if (rules.maxChars !== undefined) room.rules.maxChars = clampInt(rules.maxChars, 120, 4000, room.rules.maxChars)
    if (rules.maxAutoRounds !== undefined) {
      room.rules.maxAutoRounds = clampInt(rules.maxAutoRounds, 1, 10, room.rules.maxAutoRounds)
    }
  }
  return room
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

export function dissolveRoom(state, { roomId } = {}) {
  const room = requireRoom(state, roomId)
  state.rooms = state.rooms.filter((row) => row.id !== room.id)
  if (state.activeRoomId === room.id) state.activeRoomId = state.rooms[0]?.id ?? null
  return room
}

/**
 * 清空一间屋的历史消息。
 *
 * 只动 messages，不动成员、规则、nextSeq：seq 是客户端增量与未读游标的唯一基准，
 * 清零会让所有人手里的游标错位。所以旧消息删掉，游标继续往前。
 */
export function clearMessages(state, { roomId } = {}) {
  const room = requireRoom(state, roomId)
  room.messages = []
  room.activity = null
  return room
}

export function addMember(state, { roomId, member } = {}) {
  const room = requireRoom(state, roomId)
  if (room.members.length >= LIMITS.members) fail('room_full')
  if (room.members.some((row) => row.id === member.id)) return getMember(room, member.id)
  const origin = normalizeOrigin(member.origin)
  // 颜色是这间屋里的一个座位：调用方给了就用它（agent 可能是人挑的），
  // 没给（旧存档、别人那台的老版本）就找一档屋里还没人坐的。
  const color = claimColor(room, { wanted: member.color })
  const row = {
    id: member.id,
    kind: member.kind === 'bot' ? 'bot' : 'human',
    name: clean(member.name, LIMITS.name) || (member.kind === 'bot' ? 'agent' : '访客'),
    role: clean(member.role, LIMITS.role),
    color,
    botId: member.botId ?? null,
    sessionId: member.sessionId ?? null,
    // owner 是「这个成员由哪台机器负责」：'local' 由本机驱动，peerId 表示
    // 它的人和 agent 都在那台机器上 —— 本机不能替它说话，只能把这一轮派发过去。
    owner: typeof member.owner === 'string' && member.owner ? member.owner : 'local',
    origin,
    joinedAt: new Date().toISOString(),
    // 来源决定初始在线态：LAN 进来的人在「别的机器上」，不能标成本机在线。
    reach: member.reach ?? (member.kind === 'bot' ? 'local' : origin.kind === 'lan' ? 'lan' : 'here'),
    // 席位：这条落盘的 link 在这间屋里的身份。peerId 是进程现发的（重启就没意义），
    // instance 不会变 —— 宿主重启或清扫之后，靠它把同一组成员 id 接回去。
    seat: typeof member.seat === 'string' && member.seat ? member.seat.slice(0, 64) : null,
  }
  // 外部成员：背后是一个已经活着的会话（用户正在聊的那个），不是插件自己开的 agent。
  // 只在真的是外部成员时才写这个字段，普通成员的形状保持不变。
  if (member.external === true) row.external = true
  room.members.push(row)
  return row
}

export function normalizeOrigin(origin) {
  if (!origin || typeof origin !== 'object') return { kind: 'local', peer: null, machine: null }
  if (origin.kind === 'lan') {
    return {
      kind: 'lan',
      peer: typeof origin.peer === 'string' ? origin.peer.slice(0, 64) : null,
      machine: typeof origin.machine === 'string' ? origin.machine.slice(0, 64) : null,
    }
  }
  return { kind: 'local', peer: null, machine: null }
}

/** 这台机器之外的人和他带的 agent：他们的回合必须派发出去，不能本地跑。 */
export const isRemoteMember = (member) => Boolean(member && member.owner && member.owner !== 'local')

/** 这个成员背后是一个已经活着的会话（就是用户正在聊的那个），不是插件自己开的 agent。 */
export const isExternalMember = (member) => Boolean(member && member.external === true)

/** 某个 peer 在这间屋子里占的所有成员。断线/离开时整组撤掉。 */
export function membersOfPeer(room, peerId) {
  return room.members.filter((member) => member.owner === peerId)
}

/** 席位表里那条 link 的身份；没有就 null（旧 state.json 里没有 lanSeats 也照常工作）。 */
export function seatOf(room, instance) {
  if (!instance) return null
  return room.lanSeats?.[instance] ?? null
}

/**
 * 记下一条 link 在这间屋里的身份。
 *
 * 记的是成员 id：人与他带的 agent 各一个。回来时按这些 id 重新落座，
 * 历史消息的 authorId 才对得上，已读游标也还认得出来。
 */
export function rememberSeat(room, instance, seat) {
  if (!instance) return null
  room.lanSeats ??= {}
  room.lanSeats[instance] = {
    human: seat?.human ?? null,
    agents: { ...(seat?.agents ?? {}) },
    chair: seat?.chair ?? null,
    machine: seat?.machine ?? null,
    seenAt: Date.now(),
  }
  trimSeats(room)
  return room.lanSeats[instance]
}

/** 只留最近的 SEAT_LIMIT 台：被丢掉的席位连它的已读游标一起清，别留孤儿。 */
function trimSeats(room) {
  const seats = room.lanSeats
  if (!seats) return
  const order = Object.keys(seats).sort((a, b) => (seats[a]?.seenAt ?? 0) - (seats[b]?.seenAt ?? 0))
  while (order.length > SEAT_LIMIT) {
    const key = order.shift()
    const seat = seats[key]
    if (seat) {
      for (const id of [seat.human, ...Object.values(seat.agents ?? {})]) if (id) delete room.reads[id]
    }
    delete seats[key]
  }
}

/**
 * 某个 peer 在这间屋子里占的成员整组撤掉（断线超时、主动离开、宿主重启清理）。
 *
 * keepSeat=true：先把这一组的身份记进席位表再撤人。加进来那台机器只是暂时不在，
 * 它回来时成员 id 不变 —— 否则它自己过去说的话会被当成别人说的，
 * 整段历史也会因为游标归零重新变成未读。
 * keepSeat=false（主动离开）：连席位一起忘掉，人已经明确退出了。
 */
export function removePeer(state, { roomId, peerId, keepSeat = false } = {}) {
  const room = requireRoom(state, roomId)
  const removed = membersOfPeer(room, peerId)
  const seats = new Map()
  for (const member of removed) {
    if (!member.seat) continue
    const group = seats.get(member.seat) ?? { human: null, agents: {}, chair: null, machine: null }
    if (member.kind === 'human') {
      group.human = member.id
      group.machine = member.origin?.machine ?? null
    } else if (member.botId) group.agents[member.botId] = member.id
    // 椅子存的是成员 id：人暂时不在，椅子不该就此空掉，等它回来还坐原处。
    if (room.rules.chairId === member.id) group.chair = member.id
    seats.set(member.seat, group)
  }
  for (const [key, group] of seats) {
    if (keepSeat) rememberSeat(room, key, group)
    else if (room.lanSeats) {
      for (const id of [group.human, ...Object.values(group.agents)]) if (id) delete room.reads[id]
      delete room.lanSeats[key]
    }
  }
  for (const member of removed) {
    room.members = room.members.filter((row) => row.id !== member.id)
    if (room.rules.chairId === member.id) room.rules.chairId = null
    // 有席位的成员，游标要留着：回来时不用把整段历史重新数一遍未读。
    if (!(keepSeat && member.seat)) delete room.reads[member.id]
  }
  return removed
}

export function removeMember(state, { roomId, memberId } = {}) {
  const room = requireRoom(state, roomId)
  if (memberId === state.self.id) fail('cannot_remove_self')
  const member = getMember(room, memberId)
  if (!member) fail('member_not_found')
  room.members = room.members.filter((row) => row.id !== memberId)
  if (room.rules.chairId === memberId) room.rules.chairId = null
  delete room.reads[memberId]
  return member
}

export function updateMember(state, { roomId, memberId, patch = {} } = {}) {
  const room = requireRoom(state, roomId)
  const member = getMember(room, memberId)
  if (!member) fail('member_not_found')
  // 先验颜色再动别的字段：这一档被别人占了就直接报错，
  // 不能名字已经改掉、颜色才失败 —— 那样界面上看着「改了一半」。
  // 颜色只认表里那几档：别的值一律忽略（不是报错）—— 那是界面的一个点了没用的点击，
  // 不值得让整次更新失败。但**合法却被同屋别人占着**要说清楚：他挑的是这一档，
  // 不能替他换成另一档（strict）。
  if (patch.color !== undefined && isWhaleColor(patch.color)) {
    member.color = claimColor(room, {
      wanted: patch.color,
      current: member.color,
      exceptId: member.id,
      strict: true,
    })
  }
  if (patch.name !== undefined) {
    const label = clean(patch.name, LIMITS.name)
    if (!label) fail('member_name_required')
    member.name = label
  }
  if (patch.role !== undefined) member.role = clean(patch.role, LIMITS.role)
  if (patch.reach !== undefined && typeof patch.reach === 'string') member.reach = patch.reach.slice(0, 32)
  if (patch.origin !== undefined) member.origin = normalizeOrigin(patch.origin)
  return member
}

/**
 * 往房间里放一条消息。
 *
 * seq 是房间内的严格递增游标，客户端用它做增量与未读；id 用来做幂等
 * （客户端重发同一条不会进两遍）。
 */
export function postMessage(state, { roomId, authorId, text, mentions, replyTo, origin, status = 'sent', opKey } = {}) {
  const room = requireRoom(state, roomId)
  const body = clean(text, LIMITS.text)
  if (!body && status !== 'error') fail('message_empty')
  if (opKey) {
    const existing = room.messages.find((message) => message.opKey === opKey)
    if (existing) return existing
  }
  let author = getMember(room, authorId)
  if (!author && authorId === state.self.id) {
    // 自愈：房间从旧版本带过来的、没有 self 成员的情况。
    author = addMember(state, {
      roomId,
      member: { id: state.self.id, kind: 'human', name: state.self.name, origin: { kind: 'local' } },
    })
  }
  if (!author) fail('author_not_in_room')
  const seq = room.nextSeq
  room.nextSeq = seq + 1
  const message = {
    seq,
    id: newId('ms'),
    at: new Date().toISOString(),
    authorId: author.id,
    authorName: author.name,
    authorKind: author.kind,
    text: body,
    mentions: mergeMentions(room, normalizeMentions(room, mentions), body),
    replyTo: Number.isSafeInteger(replyTo) ? replyTo : null,
    origin: normalizeOrigin(origin ?? author.origin),
    status,
    opKey: opKey ?? null,
  }
  room.messages.push(message)
  if (room.messages.length > LIMITS.messages) room.messages.splice(0, room.messages.length - LIMITS.messages)
  // 发言人自己的游标跟着走；别人的未读因此才准。
  room.reads[author.id] = seq
  return message
}

function normalizeMentions(room, mentions) {
  if (!Array.isArray(mentions)) return []
  const ids = []
  for (const raw of mentions) {
    const text = String(raw ?? '').trim()
    if (!text) continue
    const member =
      getMember(room, text) ??
      room.members.find((row) => row.name === text || row.name.toLowerCase() === text.toLowerCase())
    if (member && !ids.includes(member.id)) ids.push(member.id)
  }
  return ids
}

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 从正文里认出 @名字。
 *
 * 为什么不让客户端算：客户端的 UI 可能漏、接口调用方（LAN / curl）根本没有 UI。
 * 「谁被 @ 了」是房间的事实，得由 Host 自己认。名字长的先匹配，避免 A 把 Alice 吃掉。
 */
export function mentionsInText(room, text) {
  const names = room.members
    .map((member) => member.name)
    .filter((name) => typeof name === 'string' && name.length > 0)
    .sort((left, right) => right.length - left.length)
  if (!names.length) return []
  const pattern = new RegExp('@(' + names.map(escapeRegExp).join('|') + ')', 'g')
  const ids = []
  let match
  while ((match = pattern.exec(String(text ?? ''))) !== null) {
    const member = room.members.find((row) => row.name === match[1])
    if (member && !ids.includes(member.id)) ids.push(member.id)
  }
  return ids
}

function mergeMentions(room, declared, text) {
  const merged = [...declared]
  for (const id of mentionsInText(room, text)) if (!merged.includes(id)) merged.push(id)
  return merged
}

export function markRead(state, { roomId, memberId, seq } = {}) {
  const room = requireRoom(state, roomId)
  const member = getMember(room, memberId)
  if (!member) fail('member_not_found')
  const top = Number.isSafeInteger(seq) ? seq : room.nextSeq - 1
  room.reads[memberId] = Math.max(room.reads[memberId] ?? 0, Math.min(top, room.nextSeq - 1))
  return room
}

export function unreadOf(room, memberId) {
  const cursor = room.reads[memberId] ?? 0
  return room.messages.filter((message) => message.seq > cursor && message.authorId !== memberId).length
}

/** 给模型看的对话记录：跳过失败占位与房间外的东西。 */
export function transcriptOf(room, { limit = 24, selfId = 'me' } = {}) {
  return room.messages
    // notice 是「这一轮没执行」的说明，不是谁说过的话：给模型看只会让它以为有人说过。
    .filter((message) => message.status !== 'error' && message.status !== 'notice')
    .slice(-limit)
    .map((message) => {
      // 身份按 authorKind 说，来源按 origin 说 —— 这是两件事。
      // 以前只按「是不是我」分，结果 LAN 里那台机器上的真人被说成「agent」，
      // 模型会把他当成另一个 agent 来接话。
      const human = typeof message.authorKind === 'string'
        ? message.authorKind === 'human'
        : message.authorId === selfId
      const who = `${message.authorName}（${human ? '人' : 'agent'}）`
      const origin = message.origin?.kind === 'lan' ? '〔远程〕' : ''
      return `#${message.seq} ${origin}${who}：${message.text}`
    })
    .join('\n')
}

/** 从一条消息里找出被点名、且在屋里的 agent。 */
export function mentionedBots(room, message) {
  const ids = message?.mentions ?? []
  return ids
    .map((id) => getMember(room, id))
    .filter((member) => member && member.kind === 'bot')
}

export function botsOf(room) {
  return room.members.filter((member) => member.kind === 'bot')
}
