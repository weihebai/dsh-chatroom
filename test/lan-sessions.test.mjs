import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/host/plugin.js'
import { call, fakeCtx, until } from './helpers/fake-ctx.mjs'

/**
 * 一台机器带着**两个** agent 进屋。
 *
 * 前面的 LAN 用例里每台机器只带一个 agent —— 那样测不出「同一台机器上两个 agent 会不会
 * 串到同一个会话里」。而这正是这个插件的核心承诺：成员是 Bot，各有各的原生会话与记忆。
 * 串了不会报错：两个人格共用一个会话，几轮之后 A 的口吻里会出现 B 的上下文，界面上却
 * 看起来一切正常。
 *
 * 所以这里钉三件事：
 *   1. 同一台机器上的两个 agent 各自拿到独立的 sessionId；
 *   2. 递给模型的提示只含它自己的职责，不夹带另一个人的；
 *   3. 下一轮还是那个会话（记忆是连续的，不是每轮新开一个）。
 */

process.env.DSH_CHATROOM_PORT = '0'

async function boot(name, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), `sessions-${name}-`))
  // 这组用例演的是跨机派发本身，不是授权门：显式开到完全授权。
  // 默认档位是只读，那道门单独在 test/auth-gate.test.mjs 里测。
  const { auth = 'full', ...rest } = options
  const fake = fakeCtx(dir, rest)
  const registered = new Map()
  fake.ctx.inject = (_keys, callback) => callback({ get: () => ({ register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name) } }) })
  const dispose = await apply(fake.ctx)
  if (auth) {
    const granted = await call(fake.routes, 'command', { action: 'auth.set', input: { level: auth } })
    if (!granted.ok) throw new Error(`设置本机授权失败：${JSON.stringify(granted.error)}`)
  }
  return { dir, dispose, registered, ...fake }
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

const mirrorOf = (view) => view.rooms.find((room) => room.remote)

/**
 * 按「这一轮是以谁的身份跑的」决定回答内容。
 *
 * 不能用「提示里提到哪个词」来判断：提示带着房间历史，阿甲先说过一句带「退货率」的话，
 * 阿乙那轮的提示里也会出现这个词 —— 那样两个 agent 会答成同一段，看起来像串台，其实是
 * 假模型偷懒。
 */
const reply = (text) =>
  text.includes('以「阿甲」的身份') ? '甲这边：退货率 7.1%。' : '乙这边：尾货占六成。'

test('一台机器带两个 agent：各有各的原生会话，提示不串、记忆连续', async () => {
  const host = await boot('host', { reply: '宿主：这些数我记下了。' })
  const guest = await boot('guest', { reply })
  try {
    // ---- 宿主：一间屋子，本机不放 agent（这一轮只看远程那台机器）
    const created = await command(host, 'room.create', { name: '两个 agent 同台' })
    const roomId = created.rooms[0].id
    const port = (await snapshot(host)).lan.port

    // ---- 那台机器：同一个进程里带两个 agent，各自有职责
    await command(guest, 'room.create', { name: '我这台' })
    const guestRoomId = (await snapshot(guest)).rooms[0].id
    await command(guest, 'member.createBot', { roomId: guestRoomId, name: '阿甲', role: '退货率' })
    await command(guest, 'member.createBot', { roomId: guestRoomId, name: '阿乙', role: '尾货库存' })
    await command(guest, 'self.rename', { name: '周荻' })
    await command(guest, 'lan.join', {
      host: '127.0.0.1',
      port,
      code: created.rooms[0].code,
      machine: 'GUEST-A',
    })

    // ---- 一句话 @ 到两个 agent：两个都要被派发，且派到同一台机器上各跑各的
    await command(host, 'msg.send', { roomId, text: '@阿甲 @阿乙 各报一句本月的数。' })

    const room = await until(async () => {
      const now = (await snapshot(host)).rooms.find((row) => row.id === roomId)
      const bots = now.messages.filter((message) => message.authorKind === 'bot')
      return bots.length >= 2 ? now : null
    }, { label: '两个 agent 各说一句', timeoutMs: 8000 })

    assert.equal(guest.prompts.length, 2, `这台机器应该被派发两轮，实际 ${guest.prompts.length}`)
    assert.equal(host.prompts.length, 0, '宿主不该替远程 agent 跑模型')

    const [first, second] = guest.prompts
    assert.notEqual(first.sessionId, second.sessionId, '同一台机器上的两个 agent 不能共用一个会话')

    // 提示里「以谁的身份 / 你的职责」必须是自己的那一份：这两行错了就是人格互相污染。
    // 成员名册里出现别人的职责是正常的（屋里的人都得介绍一下），所以只盯这两行。
    const identityOf = (text) => text.match(/以「(.+?)」的身份/)?.[1]
    const roleOf = (text) => text.match(/你的职责：([^\n]+)/)?.[1]
    const forJia = guest.prompts.find((prompt) => identityOf(prompt.text) === '阿甲')
    const forYi = guest.prompts.find((prompt) => identityOf(prompt.text) === '阿乙')
    assert.ok(forJia, '应该有一轮是以阿甲的身份跑的')
    assert.ok(forYi, '应该有一轮是以阿乙的身份跑的')
    assert.notEqual(forJia.sessionId, forYi.sessionId, '两个身份不能跑在同一个会话里')
    assert.equal(roleOf(forJia.text), '退货率')
    assert.equal(roleOf(forYi.text), '尾货库存')

    // 落库：两个作者、同一个来源机器、各自的话对得上
    const byAuthor = Object.fromEntries(
      room.messages
        .filter((message) => message.authorKind === 'bot')
        .map((message) => [message.authorName, message]),
    )
    assert.match(byAuthor['阿甲'].text, /退货率/)
    assert.match(byAuthor['阿乙'].text, /尾货占六成/)
    assert.equal(byAuthor['阿甲'].origin.kind, 'lan')
    assert.equal(byAuthor['阿甲'].origin.machine, 'GUEST-A')
    assert.equal(byAuthor['阿乙'].origin.machine, 'GUEST-A')

    // ---- 再来一轮只 @阿甲：必须还是上次那个会话（记忆连续），不能每轮新开一个
    await command(host, 'msg.send', { roomId, text: '@阿甲 再补一句。' })
    await until(async () => guest.prompts.length >= 3, { label: '第二轮派发', timeoutMs: 8000 })
    const again = guest.prompts[2]
    assert.equal(again.sessionId, forJia.sessionId, '同一个 agent 的下一轮要回到同一个原生会话')
    assert.equal(guest.prompts.length, 3, '只 @ 了一个人，不该把另一个人也拉进来跑')
  } finally {
    await guest.dispose().catch(() => {})
    await host.dispose().catch(() => {})
  }
})

test('LAN 房间绑定在快照刷新后仍生效，其他房间和默认会话保持原样', async () => {
  const host = await boot('bound-host')
  const guest = await boot('bound-guest')
  try {
    const hr = (await command(host, 'room.create', { name: '远程项目' })).rooms[0]
    const gr = (await command(guest, 'room.create', { name: '本地项目' })).rooms[0]
    await command(guest, 'member.createBot', { roomId: gr.id, name: '对接员' })
    const defaultBot = (await snapshot(guest)).bots[0]
    const live = await guest.ctx.get('agents').create({ sessionId: 'bound-lan-session' })
    assert.ok(live.agent)
    await command(guest, 'lan.join', { host: '127.0.0.1', port: (await snapshot(host)).lan.port, code: hr.code })
    const tool = guest.registered.get('chatroom')
    await tool.execute({ action: 'notify', room: '远程项目', as: '对接员', text: '绑定测试' }, { agent: { id: 'bound-lan-session' } })
    const localAfter = (await snapshot(guest)).rooms.find((row) => row.id === gr.id)
    assert.equal(localAfter.members.find((m) => m.botId === defaultBot.id).sessionId, defaultBot.sessionId)
    assert.equal((await snapshot(guest)).bots[0].sessionId, defaultBot.sessionId)
    await command(host, 'msg.send', { roomId: hr.id, text: '@对接员 请回答' })
    await until(() => guest.prompts.find((p) => p.sessionId === 'bound-lan-session'), { label: '按镜像房间绑定派发', timeoutMs: 8000 })
    const mirror = (await snapshot(guest)).rooms.find((row) => row.remote)
    const bound = mirror.members.find((m) => m.botId === defaultBot.id)
    assert.equal(bound.sessionId, 'bound-lan-session')
    assert.equal(bound.sessionBound, true)
    assert.equal((await snapshot(guest)).bots[0].sessionId, defaultBot.sessionId)
  } finally {
    await guest.dispose()
    await host.dispose()
  }
})

test('加入方能在镜像房间给自己带上去的 agent 换新会话，宿主与默认会话都不受影响', async () => {
  const host = await boot('ns-host', { reply: '宿主收到。' })
  const guest = await boot('ns-guest', { reply: '好。' })
  try {
    const hr = (await command(host, 'room.create', { name: '换会话房' })).rooms[0]
    const gr = (await command(guest, 'room.create', { name: '本地' })).rooms[0]
    await command(guest, 'member.createBot', { roomId: gr.id, name: '小七', role: '对账' })
    const defaultBot = (await snapshot(guest)).bots[0]
    await command(guest, 'lan.join', { host: '127.0.0.1', port: (await snapshot(host)).lan.port, code: hr.code, machine: 'GUEST-NS' })
    const mirror = await until(async () => (await snapshot(guest)).rooms.find((row) => row.remote), { label: '镜像房间出现', timeoutMs: 8000 })
    const mine = mirror.members.find((member) => member.botId === defaultBot.id)
    assert.ok(mine, '镜像里应该有自己的 agent')
    const rowOf = (view) => view.rooms.find((row) => row.id === mirror.id).members.find((member) => member.id === mine.id)
    const switched = await command(guest, 'session.switch', { roomId: mirror.id, memberId: mine.id, mode: 'new' })
    const after = rowOf(switched)
    assert.equal(after.sessionBound, true, '返回的快照要立刻带上绑定，界面才能看到变化')
    assert.ok(after.sessionId)
    const again = rowOf(await command(guest, 'session.switch', { roomId: mirror.id, memberId: mine.id, mode: 'new' }))
    assert.notEqual(again.sessionId, after.sessionId, '再点一次要换一个新会话号')
    assert.equal((await snapshot(guest)).bots[0].sessionId, defaultBot.sessionId, 'agent 默认会话不能被改')
  } finally {
    await guest.dispose().catch(() => {})
    await host.dispose().catch(() => {})
  }
})
