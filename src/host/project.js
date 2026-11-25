import { unreadOf } from './rooms.js'
import { isWhaleColor } from './palette.js'

/**
 * 给客户端的投影：只给面板需要的字段，消息截到最近 200 条。
 *
 * 两个额外的入参都不是状态，而是「此刻谁在看」和「这台机器现在的 LAN 情况」：
 *   viewerId —— 未读游标要按看的人算。LAN 那台机器看的是它自己成员的游标，
 *               而不是本机 self 的游标（否则每台机器都会显示别人的未读数）。
 *   lan      —— 监听端口、局域网地址、在线 peer。存在内存里，不落盘：
 *               在线与否是瞬时事实，写进 state.json 只会让重启后显示假在线。
 *
 * 导出是给 QA 渲染工具用的：它要在没有 DSH 外壳的情况下复用同一份投影与分发。
 */

export const PROJECTION_MESSAGES = 200
/** 往回翻一页的默认条数与上限。上限就是投影窗口：一页从不超过屏幕上能显示的那一整屏。 */
export const PAGE_DEFAULT = 100
export const PAGE_MAX = 200

/**
 * 往回翻一页历史。
 *
 * 投影只带最近 200 条，房间能存 4000 条。没有这一步，说满 200 句之后那些话在界面上
 * 就等于不存在了 —— 界面上只留一句「只显示最近 200 条」，用户既翻不回去，
 * 也不知道到底还留着多少。这里只读、不改状态：给的是「严格早于 beforeSeq 的最后 limit 条」，
 * 外加「还有没有更早的」。
 */
export function pageMessages(room, { beforeSeq, limit } = {}) {
  const rows = room.messages
  const requested = Number(beforeSeq)
  // 不给 beforeSeq 就当作「从最新一条往前翻」：这样调用方少一个必须传的参数。
  const before = Number.isFinite(requested) ? requested : rows.length ? rows[rows.length - 1].seq + 1 : 1
  const size = Math.max(1, Math.min(PAGE_MAX, Math.trunc(Number(limit)) || PAGE_DEFAULT))
  const older = rows.filter((row) => row.seq < before)
  const page = older.slice(-size)
  return {
    messages: page,
    hasMore: older.length > page.length,
    firstSeq: page.length ? page[0].seq : null,
    // 这间屋子现在存着多少条：界面据此能说清「翻到的位置」而不只是「还有」。
    total: rows.length,
  }
}

export function project(state, extra = {}) {
  const viewerId = extra.viewerId ?? state.self.id
  const active = state.rooms.find((room) => room.id === state.activeRoomId) ?? null
  const mine = active?.members.find((member) => member.id === state.self.id) ?? null
  return {
    revision: state.revision,
    // 我的虎鲸颜色是「当前这间屋里的这一档」：换屋子就换成那间屋里我的颜色。
    // colorScope 是能力位：旧宿主把颜色当身份存（没有这个字段），界面据此把
    // 所有选颜色的入口整块收起来 —— 画出来点了也不会按「每间屋一个座位」生效。
    self: {
      id: state.self.id,
      name: state.self.name,
      color: isWhaleColor(mine?.color) ? mine.color : null,
      colorScope: 'room',
    },
    activeRoomId: state.activeRoomId,
    lan: extra.lan ?? { serving: false, port: null, addresses: [], peers: [], error: null },
    links: (state.links ?? []).map((link) => ({
      id: link.id,
      host: link.host,
      port: link.port,
      code: link.code,
      machine: link.machine ?? null,
      hostMachine: link.hostMachine ?? null,
      roomId: link.roomId,
      localRoomId: link.localRoomId,
      status: link.status ?? 'online',
      error: link.error ?? null,
      // 对面是旧版本（没有 /lan/agents）：界面要说清「agent 名单报不过去，得重启那台」。
      hostOld: link.hostOld === true,
    })),
    bots: state.bots.map((bot) => ({
      id: bot.id,
      name: bot.name,
      role: bot.role,
      cwd: bot.cwd ?? null,
      sessionId: bot.sessionId,
      lastError: bot.lastError ?? null,
      lastSpokeAt: bot.lastSpokeAt ?? null,
    })),
    rooms: state.rooms.map((room) => ({
      id: room.id,
      code: room.code,
      name: room.name,
      topic: room.topic,
      createdAt: room.createdAt,
      ownerId: room.ownerId,
      remote: room.remote ?? null,
      rules: { ...room.rules },
      activity: room.activity ?? null,
      nextSeq: room.nextSeq,
      // 镜像房间的未读由宿主按「我们这个 peer」算好随投影带过来，本地不重算：
      // 本地没有宿主的 reads 表，重算只会得到「全都没读」。
      unread: room.remote && typeof room.unread === 'number' ? room.unread : unreadOf(room, viewerId),
      // 席位是宿主内部用来认「哪台机器是哪个人」的（那条 link 的 id），
      // 不必也不该推给任何一台加入方：投影里删掉。
      members: room.members.map((member) => {
        const row = { ...member }
        delete row.seat
        return row
      }),
      messages: room.messages.slice(-PROJECTION_MESSAGES),
      // 镜像房间的「还有更早的」由宿主说了算：本机只存着它发来的那 200 条，
      // 按本地条数重算永远是 false —— 加入方就会永远翻不回更早的历史。
      truncated: room.remote ? room.truncated === true : room.messages.length > PROJECTION_MESSAGES,
    })),
  }
}
