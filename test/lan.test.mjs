import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/host/plugin.js'
import { call, fakeCtx, tick, until } from './helpers/fake-ctx.mjs'

/**
 * 两台机器的端到端：真的起 node:http 监听、真的走局域网协议的 HTTP 请求，
 * 两个独立的插件实例（各自的 state、各自的 agent 目录），只把模型换成假的。
 *
 * 这条链路里唯一没被验证的是「信号能穿透两台物理机器的防火墙」，
 * 但协议、鉴权、归属、派发、回传、镜像、失败占位都是真跑的。
 */

// 让系统挑端口：测试不该和本机正在跑的宿主抢 4399。
process.env.DSH_CHATROOM_PORT = '0'

async function boot(name, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), `lan-${name}-`))
  // 这组用例演的是「跨机派发能跑通」，不是授权门本身：所以显式开到完全授权。
  // 默认档位是只读（新装的机器不替别人的话动工具权限），那道门有 test/auth-gate.test.mjs。
  const { auth = 'full', ...rest } = options
  const fake = fakeCtx(dir, rest)
  const dispose = await apply(fake.ctx)
  if (auth) {
    const granted = await call(fake.routes, 'command', { action: 'auth.set', input: { level: auth } })
    if (!granted.ok) throw new Error(`设置本机授权失败：${JSON.stringify(granted.error)}`)
  }
  return { dir, dispose, ...fake }
}

const snapshot = async (side) => {
  const result = await call(side.routes, 'snapshot', {})
  assert.equal(result.ok, true, JSON.stringify(result.error))
  return result.value
}

const command = async (side, action, input = {}) => {
  const result = await call(side.routes, 'command', { action, input })
  assert.equal(result.ok, true, `${action} 失败：${JSON.stringify(result.error)}`)
  return result.value
}

const membersByName = (room) => Object.fromEntries(room.members.map((member) => [member.name, member]))

test('LAN 全链路：加入 → 双向发言 → 派发远程 agent → 回传落库 → 离开', async () => {
  const host = await boot('host', { reply: '宿主这边收到，数字我再核一遍。' })
  const guest = await boot('guest', { reply: '远程这边：退货率 7.1%，尾货占六成。' })
  try {
    // ---- 宿主：一间屋子 + 一个本机 agent
    const created = await command(host, 'room.create', { name: '周三对账', topic: '把两边的账对一遍' })
    const hostRoom = created.rooms[0]
    await command(host, 'member.createBot', { roomId: hostRoom.id, name: 'Claude', role: '账期' })
    const hostSnapshot = await snapshot(host)
    const port = hostSnapshot.lan.port
    assert.ok(port > 0, '宿主应该真的监听了端口')
    assert.equal(hostSnapshot.lan.serving, true)

    // ---- 加入方：先有一个自己的 agent，再加入别人的屋子
    const local = await command(guest, 'room.create', { name: '我自己的屋子' })
    await command(guest, 'member.createBot', { roomId: local.rooms[0].id, name: '阿甲', role: '退货' })
    await command(guest, 'self.rename', { name: '周荻' })
    const guestBotId = (await snapshot(guest)).bots[0].id

    const joined = await command(guest, 'lan.join', { host: '127.0.0.1', port, code: hostRoom.code })
    const link = joined.links[0]
    const mirror = joined.rooms.find((room) => room.remote)
    assert.ok(mirror, '加入方应该出现一间镜像房间')
    const peerId = mirror.remote.peerId
    assert.ok(peerId, '加入后应该拿到 peerId')
    assert.equal(mirror.remote.port, port)
    assert.equal(mirror.members.length, 4, '两边的人各一条 + 两个 agent')

    // ---- 归属：宿主看到的人是 LAN 进来的，agent 也是
    const hostView = await snapshot(host)
    const hostRoom2 = hostView.rooms.find((room) => room.id === hostRoom.id)
    const joinedMembers = membersByName(hostRoom2)
    const guestHuman = joinedMembers['周荻']
    assert.equal(guestHuman.origin.kind, 'lan', '加入方的人必须标成 LAN')
    assert.equal(guestHuman.owner, peerId)
    const remoteAgent = joinedMembers['阿甲']
    assert.equal(remoteAgent.kind, 'bot')
    assert.equal(remoteAgent.origin.kind, 'lan')
    assert.equal(remoteAgent.botId, guestBotId, '宿主记的是加入方自己的 bot id')
    assert.equal(hostRoom2.unread, 0)

    // ---- 视角翻转：加入方看自己的人是本机，看宿主的人是 LAN
    const guestView = await snapshot(guest)
    const guestMirror = guestView.rooms.find((room) => room.remote)
    const fromGuest = membersByName(guestMirror)
    assert.equal(fromGuest['周荻'].id, 'me', '镜像里「我」要对齐成本地 self')
    assert.equal(fromGuest['周荻'].origin.kind, 'local')
    assert.equal(fromGuest['阿甲'].origin.kind, 'local', '我自己带的 agent 在本机')
    assert.equal(fromGuest['Claude'].origin.kind, 'lan', '宿主那边的 agent 从这边看是远程')

    // ---- 加入方发言：必须落进宿主那间屋子，并标成 LAN 来源
    await command(guest, 'msg.send', { roomId: guestMirror.id, text: '我这边先把退货率放上来。' })
    const afterGuestPost = await until(async () => {
      const view = await snapshot(host)
      const room = view.rooms.find((row) => row.id === hostRoom.id)
      return room.messages.find((message) => message.text.includes('退货率放上来'))
    }, { label: '宿主收到加入方的消息' })
    assert.equal(afterGuestPost.authorName, '周荻')
    assert.equal(afterGuestPost.origin.kind, 'lan')

    // ---- 宿主 @ 远程 agent：本机不能替它说话，必须派发出去
    await command(host, 'msg.send', { roomId: hostRoom.id, text: '@阿甲 你那边退货率现在多少？' })
    const remoteReply = await until(async () => {
      const view = await snapshot(host)
      const room = view.rooms.find((row) => row.id === hostRoom.id)
      return room.messages.find((message) => message.authorName === '阿甲')
    }, { label: '远程 agent 的回复落进宿主房间' })
    assert.equal(remoteReply.authorKind, 'bot')
    assert.equal(remoteReply.origin.kind, 'lan', '远程 agent 的话不能被标成本机')
    assert.match(remoteReply.text, /7\.1%/)
    assert.equal(guest.prompts.length, 1, '加入方应该被派发了一轮')
    assert.match(guest.prompts[0].text, /@阿甲 你那边退货率现在多少/, '派发的 prompt 要带房间上下文')
    assert.equal(host.prompts.length, 0, '宿主不该替远程 agent 调模型')

    // ---- 镜像会跟着走：加入方也能看到这条回复，未读按它自己的游标算
    const guestAfter = await until(async () => {
      const view = await snapshot(guest)
      const room = view.rooms.find((row) => row.remote)
      return room.messages.find((message) => message.authorName === '阿甲') ? room : null
    }, { label: '加入方镜像收到远程 agent 的回复' })
    assert.ok(guestAfter.unread >= 0)
    const mirroredReply = guestAfter.messages.find((message) => message.authorName === '阿甲')
    assert.equal(mirroredReply.origin.kind, 'local', '自己 agent 说的话，在本地视角就是本机')

    // ---- 宿主的 agent 被 @ 时仍然本地跑
    await command(host, 'msg.send', { roomId: hostRoom.id, text: '@Claude 你核一下这个数。' })
    await until(async () => {
      const view = await snapshot(host)
      const room = view.rooms.find((row) => row.id === hostRoom.id)
      return room.messages.find((message) => message.authorName === 'Claude')
    }, { label: '本机 agent 的回复' })
    assert.equal(host.prompts.length, 1, '本机 agent 走本地模型')

    // ---- 未读与已读：加入方读到最新后，宿主那边的未读归零
    await until(async () => {
      const view = await snapshot(guest)
      const room = view.rooms.find((row) => row.remote)
      if (!room) return false
      if (room.unread === 0) return true
      // 读到最后一条已知消息；期间又来了新消息就再读一次（和真实用户的行为一致）。
      await command(guest, 'read.mark', { roomId: room.id, seq: room.nextSeq - 1 })
      return false
    }, { label: '未读清零' })
    const cleared = await snapshot(guest)
    assert.equal(cleared.rooms.find((room) => room.remote).unread, 0)

    // ---- 镜像房间不许在本地改规则：规则只有一份，在那台机器上
    const refused = await call(guest.routes, 'command', {
      action: 'room.update',
      input: { roomId: guestMirror.id, rules: { roundRobin: true } },
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'remote_room')

    // ---- 离开：宿主的成员被撤掉，加入方的镜像也没了
    await command(guest, 'lan.leave', { linkId: link.id })
    const hostAfterLeave = await snapshot(host)
    const leftRoom = hostAfterLeave.rooms.find((room) => room.id === hostRoom.id)
    assert.deepEqual(leftRoom.members.map((member) => member.name).sort(), ['Claude', '我'].sort())
    assert.equal(hostAfterLeave.lan.peers.length, 0)
    const guestAfterLeave = await snapshot(guest)
    assert.equal(guestAfterLeave.rooms.some((room) => room.remote), false)
    assert.equal(guestAfterLeave.links.length, 0)
  } finally {
    await guest.dispose()
    await host.dispose()
  }
})

test('房间码不对就进不来', async () => {
  const host = await boot('host-code')
  const guest = await boot('guest-code')
  try {
    await command(host, 'room.create', { name: '关门' })
    const port = (await snapshot(host)).lan.port
    const bad = await call(guest.routes, 'command', {
      action: 'lan.join',
      input: { host: '127.0.0.1', port, code: 'ZZZZZZ' },
    })
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'room_not_found')
    const after = await snapshot(guest)
    assert.equal(after.rooms.some((room) => room.remote), false)
  } finally {
    await guest.dispose()
    await host.dispose()
  }
})

test('对面机器掉线：这一轮超时后落一条失败占位，不把整轮卡死', async () => {
  process.env.DSH_CHATROOM_ASSIGN_TIMEOUT = '250'
  const host = await boot('host-timeout')
  const guest = await boot('guest-timeout')
  try {
    const created = await command(host, 'room.create', { name: '会掉线的屋子' })
    const roomId = created.rooms[0].id
    const port = (await snapshot(host)).lan.port
    await command(guest, 'room.create', { name: '客' })
    await command(guest, 'member.createBot', { roomId: (await snapshot(guest)).rooms[0].id, name: '阿乙' })
    await command(guest, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code })

    // 直接拔线（不 leave）：宿主仍然认为它在屋里，但那台机器已经不再领任务了。
    await guest.dispose()

    await command(host, 'msg.send', { roomId, text: '@阿乙 还在吗？' })
    const failure = await until(async () => {
      const view = await snapshot(host)
      const room = view.rooms.find((row) => row.id === roomId)
      return room.messages.find((message) => message.status === 'error')
    }, { label: '失败占位', timeoutMs: 5000 })
    assert.match(failure.text, /没回上来/)
    assert.match(failure.text, /阿乙/)
    const settled = await snapshot(host)
    assert.equal(settled.rooms.find((room) => room.id === roomId).activity, null, '超时后不该还挂着发言中')
  } finally {
    delete process.env.DSH_CHATROOM_ASSIGN_TIMEOUT
    await host.dispose()
  }
})

test('宿主重启：上一轮从 LAN 进来的成员不会留成幽灵', async () => {
  const host = await boot('host-restart')
  const guest = await boot('guest-restart')
  try {
    const created = await command(host, 'room.create', { name: '会重启的屋子' })
    const roomId = created.rooms[0].id
    const port = (await snapshot(host)).lan.port
    await command(guest, 'room.create', { name: '客' })
    await command(guest, 'member.createBot', { roomId: (await snapshot(guest)).rooms[0].id, name: '阿丙' })
    await command(guest, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code })
    const before = await snapshot(host)
    assert.equal(before.rooms.find((room) => room.id === roomId).members.length, 3)

    // 拔电重启：不 leave，直接关掉宿主再用同一个 profile 目录重新 apply。
    await guest.dispose()
    await host.dispose()
    const again = fakeCtx(host.dir)
    const dispose = await apply(again.ctx)
    try {
      const after = await call(again.routes, 'snapshot', {})
      const room = after.value.rooms.find((row) => row.id === roomId)
      assert.equal(room.members.length, 1, '重启后只剩本机的人')
      assert.equal(room.members[0].owner ?? 'local', 'local')
      assert.equal(after.value.lan.peers.length, 0)
    } finally {
      await dispose()
    }
  } finally {
    await host.dispose().catch(() => {})
  }
})

test('局域网端点自带门禁：没带 peerId、带错的 peerId 都进不来', async () => {  const host = await boot('host-gate')
  try {
    await command(host, 'room.create', { name: '有门禁的屋子' })
    const port = (await snapshot(host)).lan.port
    const base = `http://127.0.0.1:${port}`

    const noPeer = await fetch(`${base}/lan/state?since=-1`)
    assert.equal(noPeer.status, 403)
    const wrongPeer = await fetch(`${base}/lan/state?peerId=p_deadbeef&since=-1`)
    assert.equal(wrongPeer.status, 403)
    const unknownPath = await fetch(`${base}/lan/nope`)
    assert.equal(unknownPath.status, 404)
    const ping = await fetch(`${base}/lan/ping`)
    assert.equal(ping.status, 200)
    const body = await ping.json()
    assert.equal(body.value.serving, true)

    // 探针要能回答「对面跑的是哪一版、这份代码什么时候进的进程」。
    // 内存里的代码和磁盘上的代码可以不是同一份（插件热装/重载），所以装载时间
    // 必须是模块求值那一刻写下、之后不再变的常量。
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(body.value.code.version, pkg.version)
    assert.match(body.value.code.loadedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, '装载时间应是 ISO 时间戳')
    assert.ok(body.value.code.newestMtime, '磁盘上宿主文件的最新改动时间要能读到')
    assert.equal(body.value.code.stale, false, '刚从磁盘装载的这份代码不该被判成过期')
    assert.ok(
      Date.parse(body.value.code.newestMtime) <= Date.parse(body.value.code.loadedAt) + 1000,
      '磁盘最新改动不该晚于装载时间',
    )
    const again = await (await fetch(`${base}/lan/ping`)).json()
    assert.equal(again.value.code.loadedAt, body.value.code.loadedAt, '装载时间是常量，两次探测必须一致')
  } finally {
    await host.dispose()
  }
})

test('宿主重启后旧凭据失效：加入方不用手动重连，下一次发言自己重新握手', async () => {
  const host = await boot('host-rejoin', { reply: '重启之后还在。' })
  const guest = await boot('guest-rejoin', { reply: '这边也还在。' })
  try {
    const created = await command(host, 'room.create', { name: '会重启的屋子' })
    const roomId = created.rooms[0].id
    const port = (await snapshot(host)).lan.port
    await command(guest, 'room.create', { name: '客' })
    await command(guest, 'self.rename', { name: '周荻' })
    await command(guest, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code })
    const mirrorId = (await snapshot(guest)).rooms.find((room) => room.remote).id

    // 宿主进程换一代：同一份 profile、同一个端口，上一轮的 peerId 全部作废。
    await host.dispose()
    process.env.DSH_CHATROOM_PORT = String(port)
    const again = fakeCtx(host.dir, { reply: '重启之后还在。' })
    const dispose = await apply(again.ctx)
    try {
      // 不做任何手工重连，直接说话 —— 用户视角就是「对面重启了，我继续发」。
      const sent = await call(guest.routes, 'command', {
        action: 'msg.send',
        input: { roomId: mirrorId, text: '重启之后我还能说话。' },
      })
      assert.equal(sent.ok, true, `发言应该自己重连成功：${JSON.stringify(sent.error)}`)
      const landed = await until(async () => {
        const view = await call(again.routes, 'snapshot', {})
        const room = view.value.rooms.find((row) => row.id === roomId)
        return room.messages.find((message) => message.text.includes('重启之后我还能说话'))
      }, { label: '重启后的消息落库' })
      assert.equal(landed.authorName, '周荻')
      // 只该出现一份「周荻」：并发重连去重没做好时，这里会冒出两个。
      const view = await call(again.routes, 'snapshot', {})
      const people = view.value.rooms.find((row) => row.id === roomId).members.filter((row) => row.kind === 'human')
      assert.deepEqual(people.map((row) => row.name).sort(), ['周荻', '我'].sort())
    } finally {
      process.env.DSH_CHATROOM_PORT = '0'
      await dispose()
    }
  } finally {
    await guest.dispose().catch(() => {})
  }
})

test('加入方的桌面端重启：屋里不会同时坐着两个他，旧那组当场让位', async () => {
  const host = await boot('host-guest-restart', { reply: '宿主这边：回来了。' })
  const first = await boot('guest-guest-restart', { reply: '重启之后还是我。' })
  let restarted = null
  try {
    const created = await command(host, 'room.create', { name: '重启的客' })
    const roomId = created.rooms[0].id
    const port = (await snapshot(host)).lan.port
    await command(first, 'self.rename', { name: '周荻' })
    await command(first, 'room.create', { name: '客' })
    await command(first, 'member.createBot', { roomId: (await snapshot(first)).rooms[0].id, name: '阿丙', role: '库存' })
    await command(first, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code })
    const beforeView = await snapshot(host)
    const before = beforeView.rooms.find((room) => room.id === roomId)
    assert.equal(before.members.length, 3, '先确认屋里是：我、周荻、阿丙')
    const oldPeerId = beforeView.lan.peers[0].id
    const zhouId = before.members.find((row) => row.name === '周荻').id
    const bingId = before.members.find((row) => row.name === '阿丙').id

    // 重启之前先说一句：回来之后这句还得是「我说的」，不能变成远程某人说的。
    const mirrorId = (await snapshot(first)).rooms.find((room) => room.remote).id
    await command(first, 'msg.send', { roomId: mirrorId, text: '重启之前我说过这句。' })
    await until(async () => {
      const room = (await snapshot(host)).rooms.find((row) => row.id === roomId)
      return room.messages.find((message) => message.text.includes('重启之前我说过这句'))
    }, { label: '重启前那句落库' })

    // 桌面端重启：不 leave，关掉这一代，用同一份 profile 再 apply 一次。
    // 加入方的 link 是落盘的，所以它自己会重新握手 —— 宿主必须认得出这是同一个人。
    await first.dispose()
    const second = fakeCtx(first.dir, { reply: '重启之后还是我。' })
    restarted = { ...second, dispose: await apply(second.ctx) }

    // 认新身份而不是「只剩一份」：重新握手之前，屋里本来就只有旧那组一份，
    // 只看数量会让断言在重启生效前就通过。
    const settled = await until(async () => {
      const view = await snapshot(host)
      const room = view.rooms.find((row) => row.id === roomId)
      const zhou = room.members.filter((row) => row.name === '周荻')
      const bing = room.members.filter((row) => row.name === '阿丙')
      const fresh = view.lan.peers.length === 1 && view.lan.peers[0].id !== oldPeerId
      return fresh && zhou.length === 1 && bing.length === 1 ? { room, view } : null
    }, { timeoutMs: 6000, label: '宿主把旧那组让位，只留一份' })
    assert.equal(settled.room.members.length, 3, '重启不该在屋里多留一组人')
    assert.equal(settled.view.lan.peers[0].canAgents, true, '重新握手也要带上能力位')

    // 换的是 peerId，不是人：成员 id 不动，已读游标和历史署名才连得回去。
    assert.equal(settled.room.members.find((row) => row.name === '周荻').id, zhouId, '人的成员 id 不该换')
    assert.equal(settled.room.members.find((row) => row.name === '阿丙').id, bingId, 'agent 的成员 id 不该换')
    const mirrorAfter = await until(async () => {
      const view = await snapshot(restarted)
      const room = view.rooms.find((row) => row.remote)
      return room && room.messages.find((message) => message.text.includes('重启之前我说过这句')) ? room : null
    }, { label: '镜像把重启前那句带回来' })
    const mine = mirrorAfter.messages.find((message) => message.text.includes('重启之前我说过这句'))
    assert.equal(mine.authorId, 'me', '重启之后，我过去说的话还是我说的')
    assert.equal(mine.origin.kind, 'local')

    // 让位之后派发要落在新的那组上：不然「回来的那个人」看着在线，@ 他必然超时。
    await command(host, 'msg.send', { roomId, text: '@阿丙 重启之后还在吗？' })
    const reply = await until(async () => {
      const room = (await snapshot(host)).rooms.find((row) => row.id === roomId)
      return room.messages.find((message) => message.authorName === '阿丙')
    }, { label: '重启后的 agent 仍能被派发' })
    assert.match(reply.text, /重启之后还是我/)
    assert.equal(reply.authorId, settled.room.members.find((row) => row.name === '阿丙').id, '回话的是新那组成员')
  } finally {
    await (restarted ? restarted.dispose() : Promise.resolve()).catch(() => {})
    await first.dispose().catch(() => {})
    await host.dispose().catch(() => {})
  }
})

test('加入方重启那一刻正交在手上的那一轮：跟着它到新那组，不会变成「对面没回应」', async () => {
  // 给足窗口：这条用例要证明的是「重启回来接着跑完」，不是「超时落占位」。
  process.env.DSH_CHATROOM_ASSIGN_TIMEOUT = '15000'
  const host = await boot('host-carried', { reply: '宿主这边：收到。' })
  const first = await boot('guest-carried', { reply: '重启前领的那一轮，我跑完了。' })
  let restarted = null
  try {
    const created = await command(host, 'room.create', { name: '派发中重启' })
    const roomId = created.rooms[0].id
    const port = (await snapshot(host)).lan.port
    await command(first, 'self.rename', { name: '周荻' })
    await command(first, 'room.create', { name: '客' })
    await command(first, 'member.createBot', {
      roomId: (await snapshot(first)).rooms[0].id,
      name: '阿丁',
      role: '排期',
    })
    await command(first, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code })
    const before = await snapshot(host)
    const dingId = before.rooms.find((row) => row.id === roomId).members.find((row) => row.name === '阿丁').id
    const oldPeerId = before.lan.peers[0].id

    // 拔线（不 leave）：宿主仍把这台机器算在线，于是这一轮被派出去、挂在那条旧 peerId 上。
    await first.dispose()
    await command(host, 'msg.send', { roomId, text: '@阿丁 重启前派给你的这一轮，回来再跑。' })
    await until(async () => (await snapshot(host)).lan.pending >= 1, { label: '这一轮已经派在路上' })

    // 重启回来：同一条 link（同一份 profile），宿主应当把在路上的这一轮也交回来。
    const second = fakeCtx(first.dir, { reply: '重启前领的那一轮，我跑完了。' })
    restarted = { ...second, dispose: await apply(second.ctx) }

    const reply = await until(async () => {
      const room = (await snapshot(host)).rooms.find((row) => row.id === roomId)
      return room.messages.find((message) => message.authorName === '阿丁') ?? null
    }, { timeoutMs: 6000, label: '新那组把在路上的那一轮跑完' })
    assert.match(reply.text, /我跑完了/)
    assert.equal(reply.authorId, dingId, '回话的还是同一个成员，不该换成新造的人')
    assert.notEqual(reply.status, 'error')

    const after = await snapshot(host)
    const room = after.rooms.find((row) => row.id === roomId)
    assert.equal(
      room.messages.some((message) => message.status === 'error'),
      false,
      '人已经回来了，不该再落「没回上来」的失败占位',
    )
    assert.equal(after.lan.peers.length, 1, '屋里仍然只有它一台')
    assert.notEqual(after.lan.peers[0].id, oldPeerId, '回来的是新的一代 peerId')
  } finally {
    delete process.env.DSH_CHATROOM_ASSIGN_TIMEOUT
    await (restarted ? restarted.dispose() : Promise.resolve()).catch(() => {})
    await first.dispose().catch(() => {})
    await host.dispose().catch(() => {})
  }
})

test('宿主那台屋子没了：加入方退避重试，别对着它打紧循环', async () => {
  const host = await boot('host-lost')
  const guest = await boot('guest-lost')
  let stub = null
  try {
    const created = await command(host, 'room.create', { name: '会消失的屋子' })
    const port = (await snapshot(host)).lan.port
    await command(guest, 'room.create', { name: '客' })
    await command(guest, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code })

    // 换一台「不是我认识的那个宿主」来占这个地址：旧的 peerId 一律 403，
    // 房间码在它那儿也不存在。房间被解散后又清了 profile、或者换成另一台机器
    // 用了同一个地址，用户看到的就是这一幕。
    await host.dispose()
    const hits = { state: 0, join: 0, other: 0 }
    stub = createServer((request, response) => {
      const send = (status, payload) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload))
      }
      const path = String(request.url ?? '').split('?')[0]
      if (path === '/lan/state') {
        hits.state += 1
        send(403, { ok: false, error: { code: 'peer_unknown', message: '这张凭据不算数。' } })
        return
      }
      if (path === '/lan/join') {
        hits.join += 1
        send(400, { ok: false, error: { code: 'room_not_found', message: '这间屋子在这台机器上不存在。' } })
        return
      }
      hits.other += 1
      send(404, { ok: false, error: { code: 'not_found', message: '没有这个接口。' } })
    })
    await new Promise((resolve, reject) => {
      stub.once('error', reject)
      stub.listen(port, '127.0.0.1', resolve)
    })

    // 这 2.5 秒里它应该只试几次：重新握手失败之后要等一拍。
    // 之前是「403 秒回 → 重新握手秒回 null → 立刻再试」，一秒能打几百次。
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const total = hits.state + hits.join
    assert.ok(total > 0, '对面还在那儿（只是不认我），它应该继续重试')
    assert.ok(
      total <= 20,
      `重连失败时不该打紧循环：2.5 秒里打了 ${total} 次（state ${hits.state} / join ${hits.join}）`,
    )

    // 同时界面要能说清「对面没了」，而不是一直挂着在线。
    const view = await snapshot(guest)
    assert.equal(view.links[0].status, 'offline')
    assert.ok(view.links[0].error, '离线原因要能给人看')
  } finally {
    if (stub) await new Promise((resolve) => stub.close(resolve))
    await guest.dispose().catch(() => {})
  }
})

test('宿主解散房间：加入方留一张能清理的墓碑，不是发不出话也退不出的死胡同', async () => {
  const host = await boot('host-dissolve')
  const guest = await boot('guest-dissolve')
  try {
    const created = await command(host, 'room.create', { name: '会被解散的屋子' })
    const roomId = created.rooms[0].id
    const port = (await snapshot(host)).lan.port
    await command(guest, 'room.create', { name: '客' })
    await command(guest, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code })
    const mirrorId = (await snapshot(guest)).rooms.find((room) => room.remote).id

    await command(host, 'room.dissolve', { roomId })

    const tomb = await until(async () => {
      const view = await snapshot(guest)
      const room = view.rooms.find((row) => row.id === mirrorId)
      return room && room.remote.lost ? { room, view } : null
    }, { label: '加入方看到墓碑' })
    assert.equal(tomb.view.links[0].status, 'gone')
    assert.equal(tomb.room.messages.length, 0)
    // 历史还在，但已经写不进去了：给出明确错误码，而不是一句泛泛的失败。
    const refused = await call(guest.routes, 'command', {
      action: 'msg.send',
      input: { roomId: mirrorId, text: '还能发吗？' },
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'remote_room_gone')
    // 关键：还能自己把它从列表里清掉。
    await command(guest, 'lan.leave', { linkId: tomb.view.links[0].id })
    const after = await snapshot(guest)
    assert.equal(after.rooms.some((row) => row.id === mirrorId), false)
    assert.equal(after.links.length, 0)
  } finally {
    await guest.dispose()
    await host.dispose()
  }
})

test('进屋之后再改名：宿主那边的成员当场换名字，不会被当成第二个人', async () => {
  const host = await boot('host-rename')
  const guest = await boot('guest-rename')
  try {
    const created = await command(host, 'room.create', { name: '改名的屋子' })
    const roomId = created.rooms[0].id
    const port = (await snapshot(host)).lan.port
    await command(guest, 'room.create', { name: '客' })
    // 不先改名就进屋：两边都叫「我」，宿主只能用机器名兜底。
    await command(guest, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code })
    const before = await snapshot(host)
    const room0 = before.rooms.find((row) => row.id === roomId)
    const strangers = room0.members.filter((row) => row.kind === 'human' && row.origin.kind === 'lan')
    assert.equal(strangers.length, 1)
    const stranger = strangers[0]
    assert.notEqual(stranger.name, '我', '同名时宿主必须用机器名兜底，屋里不能有两个「我」')
    const memberCount = room0.members.length

    // 进屋之后再改：走 /lan/self，改的是同一条成员记录。
    await command(guest, 'self.rename', { name: '周荻' })
    const renamed = await until(async () => {
      const view = await snapshot(host)
      const room = view.rooms.find((row) => row.id === roomId)
      const member = room.members.find((row) => row.id === stranger.id)
      return member && member.name === '周荻' ? room : null
    }, { label: '宿主看到加入方的新名字' })
    assert.equal(renamed.members.length, memberCount, '改名不能凭空多一个人')
    assert.equal(renamed.members.filter((row) => row.name === '周荻').length, 1)

    // 改名之后说的话，落库时用的就是新名字。
    const mirrorId = (await snapshot(guest)).rooms.find((room) => room.remote).id
    await command(guest, 'msg.send', { roomId: mirrorId, text: '以后叫我周荻。' })
    const spoken = await until(async () => {
      const view = await snapshot(host)
      const room = view.rooms.find((row) => row.id === roomId)
      return room.messages.find((message) => message.text.includes('以后叫我周荻'))
    }, { label: '改名后的发言落库' })
    assert.equal(spoken.authorName, '周荻')
    assert.equal(spoken.authorId, stranger.id, '还是同一个成员，不是新成员')
  } finally {
    await guest.dispose()
    await host.dispose()
  }
})

test('连不上的时候要说清「哪台、为什么」，不能只丢一句 fetch failed', async () => {
  // 加入失败是人最常撞上的一条路（地址写错、对面没开、码不对），报错的质量就是产品本身。
  // Node 的 fetch 把真正的原因放在 cause 里，直接取 message 会得到 'fetch failed'。
  // 端口用一个「刚占过又放掉」的号：确定没人监听，且不像 1 号端口那样被 undici 直接拦掉。
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const closedPort = probe.address().port
  await new Promise((resolve) => probe.close(resolve))

  const guest = await boot('guest-unreachable')
  try {
    const result = await call(guest.routes, 'command', {
      action: 'lan.join',
      input: { host: `127.0.0.1:${closedPort}`, code: 'ZZZZZZ' },
    })
    assert.equal(result.ok, false, '连不上不该当成功')
    assert.equal(result.error.code, 'lan_unreachable')
    const message = String(result.error.message ?? '')
    assert.match(message, new RegExp(`连不上 127\\.0\\.0\\.1:${closedPort}`), `要写清是哪台：${message}`)
    assert.match(message, /没在监听这个端口/, `要说清为什么：${message}`)
    assert.doesNotMatch(message, /fetch failed/, `不能把底层消息直接丢给用户：${message}`)
    assert.doesNotMatch(message, /\/lan\/join/, `报错里不该出现内部端点：${message}`)
  } finally {
    await guest.dispose()
  }
})

test('跑着的宿主会清掉真的关掉的机器，但不会清正在长轮询的那台', async () => {
  // 把 idle 压到 400ms：测试要量的是「清扫逻辑」，不是等 45 秒。
  process.env.DSH_CHATROOM_PEER_IDLE = '400'
  const host = await boot('host-sweep')
  const guest = await boot('guest-sweep')
  try {
    const created = await command(host, 'room.create', { name: '会掉人的屋子' })
    const roomId = created.rooms[0].id
    const port = (await snapshot(host)).lan.port
    await command(guest, 'room.create', { name: '客' })
    await command(guest, 'member.createBot', { roomId: (await snapshot(guest)).rooms[0].id, name: '阿丁' })
    await command(guest, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code })

    // 对面一直挂着长轮询（这是它在屋里的常态），不能被当成掉线清掉。
    await tick(1200)
    const alive = await snapshot(host)
    assert.equal(alive.rooms.find((room) => room.id === roomId).members.length, 3, '长轮询中的机器不算掉线')
    assert.equal(alive.lan.peers.length, 1)

    // 真的关掉（不发 leave，模拟关窗口 / 掉网），清扫器应该把整组成员撤掉。
    await guest.dispose()
    const swept = await until(async () => {
      const view = await snapshot(host)
      const room = view.rooms.find((row) => row.id === roomId)
      return room.members.length === 1 && view.lan.peers.length === 0 ? view : null
    }, { label: '清扫掉线的机器', timeoutMs: 8000 })
    assert.equal(swept.rooms.find((room) => room.id === roomId).members[0].owner ?? 'local', 'local')
  } finally {
    delete process.env.DSH_CHATROOM_PEER_IDLE
    await host.dispose()
  }
})

test('LAN 署名：authorBotId 只能署自己报备过的 agent；silent 只落库不触发回合', async () => {
  const host = await boot('host-author')
  const guest = await boot('guest-author')
  try {
    const created = await command(host, 'room.create', { name: '联调屋' })
    const roomId = created.rooms[0].id
    await command(host, 'member.createBot', { roomId, name: 'Claude' })
    const port = (await snapshot(host)).lan.port
    const hostBotId = (await snapshot(host)).bots[0].id

    const local = await command(guest, 'room.create', { name: '我的屋子' })
    await command(guest, 'member.createBot', { roomId: local.rooms[0].id, name: '阿甲' })
    const guestBotId = (await snapshot(guest)).bots[0].id
    const joined = await command(guest, 'lan.join', { host: '127.0.0.1', port, code: created.rooms[0].code })
    const peerId = joined.rooms.find((room) => room.remote).remote.peerId

    const post = async (payload) => {
      const response = await fetch('http://127.0.0.1:' + port + '/lan/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ peerId }, payload)),
      })
      return { status: response.status, body: await response.json() }
    }

    // 以自己报备过的 agent 署名：宿主认，落库署名是「阿甲」；silent 不触发任何回合。
    const sent = await post({ text: '我以阿甲的身份说一句。', authorBotId: guestBotId, silent: true })
    assert.equal(sent.body.ok, true, JSON.stringify(sent.body))
    const room = (await snapshot(host)).rooms.find((row) => row.id === roomId)
    const message = room.messages.find((row) => row.text.includes('以阿甲的身份'))
    assert.ok(message, '消息应该落进宿主房间')
    assert.equal(message.authorName, '阿甲')
    assert.equal(message.authorKind, 'bot')
    assert.equal(message.origin.kind, 'lan')
    await tick(120)
    assert.equal(host.prompts.length, 0, 'silent 不该触发宿主的 agent')
    assert.equal(guest.prompts.length, 0, 'silent 不该派发到加入方')

    // 冒名：用宿主自己 agent 的 id，不属于这条连接 → 拒绝。
    const spoof = await post({ text: '我是 Claude', authorBotId: hostBotId })
    assert.equal(spoof.body.ok, false)
    assert.equal(spoof.body.error.code, 'unknown_agent')
    // 不存在的 id 同样拒绝。
    const bogus = await post({ text: '我是幽灵', authorBotId: 'bot_nobody' })
    assert.equal(bogus.body.ok, false)
    assert.equal(bogus.body.error.code, 'unknown_agent')
  } finally {
    await host.dispose()
    await guest.dispose()
  }
})
