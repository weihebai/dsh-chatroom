import assert from 'node:assert/strict'
import test from 'node:test'
import { emptyState } from '../src/host/state.js'
import { addMember, botsOf, createRoom, isExternalMember, mentionedBots, postMessage } from '../src/host/rooms.js'
import { createChatroomTool } from '../src/host/tool.js'
import { createSpeaker } from '../src/host/speak.js'

function fakeStore(state = emptyState()) {
  return {
    state,
    commit(mutate) {
      const result = mutate(state)
      state.revision += 1
      return result
    },
    inspect(read) {
      return read(state)
    },
    notify() {},
  }
}

const runtimeWith = (store, calls) => ({
  store,
  speaker: { afterHumanMessage: (payload) => calls.push(payload) },
  lan: null,
})

const addLocalAgent = (store, room, name, botId) => {
  store.state.bots.push({
    id: botId,
    name,
    role: '',
    sessionId: 'sess-' + name,
    cwd: null,
    createdAt: '',
    lastError: null,
    lastSpokeAt: null,
  })
  return addMember(store.state, {
    roomId: room.id,
    member: { id: 'm_' + botId, kind: 'bot', name, role: '', botId, sessionId: 'sess-' + name, origin: { kind: 'local' } },
  })
}

test('外部成员：external 标记保留，普通成员形状不变', () => {
  const state = emptyState()
  const room = createRoom(state, { name: '联调' })
  const external = addMember(state, {
    roomId: room.id,
    member: { id: 'm_ext_1', kind: 'bot', name: '旧登记', sessionId: 'sess-back', external: true },
  })
  assert.equal(external.external, true)
  assert.equal(isExternalMember(external), true)
  const plain = addMember(state, {
    roomId: room.id,
    member: { id: 'm_plain', kind: 'bot', name: '前端', botId: 'b1', sessionId: 's1' },
  })
  assert.equal('external' in plain, false)
  assert.equal(isExternalMember(plain), false)
  const message = postMessage(state, { roomId: room.id, authorId: state.self.id, text: '@旧登记 在吗' })
  assert.deepEqual(mentionedBots(room, message).map((row) => row.name), ['旧登记'])
})

test('list：标明哪个是本机、哪个是从 LAN 加入', async () => {
  const store = fakeStore()
  const room = createRoom(store.state, { name: '联调' })
  addLocalAgent(store, room, 'backend-dev', 'bot_backend')
  addMember(store.state, {
    roomId: room.id,
    member: { id: 'h_lan', kind: 'human', name: 'yuk', origin: { kind: 'lan', peer: '192.168.1.9', machine: 'hm' } },
  })
  const tool = createChatroomTool(runtimeWith(store, []))
  const list = await tool.execute({ action: 'list' }, { agent: { id: 'sess-mine' } })
  assert.match(list.message, /backend-dev（agent，本机）/)
  assert.match(list.message, /yuk（人，LAN·hm）/)
})

test('send：用本机已创建 agent 的身份发，绝不新建成员', async () => {
  const store = fakeStore()
  const room = createRoom(store.state, { name: '联调' })
  addLocalAgent(store, room, 'backend-dev', 'bot_backend')
  addLocalAgent(store, room, 'frontend-dev', 'bot_frontend')
  const before = room.members.length
  const calls = []
  const tool = createChatroomTool(runtimeWith(store, calls))
  const result = await tool.execute(
    { action: 'send', room: '联调', as: 'backend-dev', to: ['frontend-dev'], text: '接口好了，你接一下。' },
    { agent: { id: 'sess-mine' } },
  )
  assert.match(result.message, /backend-dev/)
  const live = store.state.rooms.find((row) => row.id === room.id)
  assert.equal(live.members.length, before, '不该多出成员')
  const last = live.messages.at(-1)
  assert.equal(last.authorName, 'backend-dev')
  assert.match(last.text, /@frontend-dev/)
  assert.deepEqual(last.mentions, ['m_bot_frontend'])
  assert.equal(calls.length, 1)
  // 发送即绑定：这只 agent 的会话换成当前会话，并被标成 external（@ 回来落在这里）。
  const boundBot = store.state.bots.find((b) => b.id === 'bot_backend')
  assert.equal(boundBot.sessionId, 'sess-mine')
  assert.equal(boundBot.external, true)
})

test('bind:false 只发不绑，成员会话不动', async () => {
  const store = fakeStore()
  const room = createRoom(store.state, { name: '联调' })
  addLocalAgent(store, room, 'backend-dev', 'bot_backend')
  const calls = []
  const tool = createChatroomTool(runtimeWith(store, calls))
  await tool.execute(
    { action: 'send', room: '联调', as: 'backend-dev', bind: false, to: [], text: '只是通知一下' },
    { agent: { id: 'sess-mine' } },
  )
  const bot = store.state.bots.find((b) => b.id === 'bot_backend')
  assert.equal(bot.sessionId, 'sess-backend-dev')
  assert.notEqual(bot.external, true)
})

test('as 指向不存在的成员：报错并列出可用名字，不建成员', async () => {
  const store = fakeStore()
  const room = createRoom(store.state, { name: '联调' })
  addLocalAgent(store, room, 'backend-dev', 'bot_backend')
  const before = room.members.length
  const tool = createChatroomTool(runtimeWith(store, []))
  await assert.rejects(
    () => tool.execute({ action: 'send', room: '联调', as: 'lead', to: [], text: '嗨' }, { agent: { id: 'sess-mine' } }),
    /没有你本机创建的名叫「lead」的 agent/,
  )
  assert.equal(store.state.rooms.find((row) => row.id === room.id).members.length, before)
})

test('多个本机 agent 且没给 as：报错要求指定', async () => {
  const store = fakeStore()
  const room = createRoom(store.state, { name: '联调' })
  addLocalAgent(store, room, 'backend-dev', 'bot_backend')
  addLocalAgent(store, room, 'frontend-dev', 'bot_frontend')
  const tool = createChatroomTool(runtimeWith(store, []))
  await assert.rejects(
    () => tool.execute({ action: 'send', room: '联调', text: '嗨' }, { agent: { id: 'sess-mine' } }),
    /请用 as 指定用哪个身份发言/,
  )
})

test('send 不 @ 自己；只 @ 自己时不开回合', async () => {
  const store = fakeStore()
  const room = createRoom(store.state, { name: '联调' })
  addLocalAgent(store, room, 'backend-dev', 'bot_backend')
  const calls = []
  const tool = createChatroomTool(runtimeWith(store, calls))
  const result = await tool.execute(
    { action: 'send', room: '联调', as: 'backend-dev', to: ['backend-dev'], text: '自说自话' },
    { agent: { id: 'sess-mine' } },
  )
  assert.match(result.message, /没有触发任何 agent/)
  assert.equal(calls.length, 0)
  assert.deepEqual(store.state.rooms.find((row) => row.id === room.id).messages.at(-1).mentions, [])
})

test('notify：不 @ 人、不触发任何回合', async () => {
  const store = fakeStore()
  const room = createRoom(store.state, { name: '联调' })
  addLocalAgent(store, room, 'backend-dev', 'bot_backend')
  const calls = []
  const tool = createChatroomTool(runtimeWith(store, calls))
  const result = await tool.execute({ action: 'notify', room: '联调', as: 'backend-dev', text: '都对接完了。' }, { agent: { id: 'sess-mine' } })
  assert.match(result.message, /通知/)
  assert.equal(calls.length, 0)
  const last = store.state.rooms.find((row) => row.id === room.id).messages.at(-1)
  assert.equal(last.text, '都对接完了。')
  assert.deepEqual(last.mentions, [])
})

test('leave：把这个会话登记的成员身份移除', async () => {
  const store = fakeStore()
  const room = createRoom(store.state, { name: '联调' })
  addMember(store.state, {
    roomId: room.id,
    member: { id: 'm_ext_x', kind: 'bot', name: 'lead', sessionId: 'sess-mine', external: true },
  })
  const tool = createChatroomTool(runtimeWith(store, []))
  const result = await tool.execute({ action: 'leave' }, { agent: { id: 'sess-mine' } })
  assert.match(result.message, /移除/)
  assert.equal(store.state.rooms.find((row) => row.id === room.id).members.some((m) => m.name === 'lead'), false)
})

test('镜像房间：用本机镜像成员的 botId 署名转发，本地不落消息', async () => {
  const store = fakeStore()
  const room = createRoom(store.state, { name: '他的屋' })
  room.remote = { host: 'http://127.0.0.1:1', port: 1, peerId: 'p1', machine: '同事的电脑' }
  store.state.bots.push({ id: 'bot_backend', name: 'backend-dev', role: '', sessionId: 'sess-old', cwd: null, createdAt: '', lastError: null, lastSpokeAt: null })
  addMember(store.state, {
    roomId: room.id,
    member: { id: 'm_mine_agent', kind: 'bot', name: 'backend-dev', botId: 'bot_backend', sessionId: null, origin: { kind: 'local' } },
  })
  addMember(store.state, {
    roomId: room.id,
    member: { id: 'm_host_agent', kind: 'bot', name: '宿主agent', botId: 'bot_host', origin: { kind: 'lan', peer: 'x', machine: 'host' } },
  })
  const sent = []
  let announced = 0
  const runtime = {
    store,
    speaker: null,
    lan: { async announceAgents() { announced += 1 }, async send(args) { sent.push(args); return {} } },
  }
  const tool = createChatroomTool(runtime)
  const result = await tool.execute(
    { action: 'send', room: '他的屋', as: 'backend-dev', to: ['宿主agent'], text: '接口好了' },
    { agent: { id: 'sess-mine' } },
  )
  assert.match(result.message, /backend-dev/)
  assert.equal(announced, 1)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].authorBotId, 'bot_backend')
  assert.deepEqual(sent[0].mentions, ['宿主agent'])
  assert.equal(store.state.rooms.find((row) => row.id === room.id).messages.length, 0)
  const boundBot = store.state.bots.find((b) => b.id === 'bot_backend')
  assert.equal(boundBot.sessionId, 'sess-mine')
  assert.equal(boundBot.external, true)
})

test('镜像房间：notify 走局域网 silent', async () => {
  const store = fakeStore()
  const room = createRoom(store.state, { name: '他的屋' })
  room.remote = { host: 'http://127.0.0.1:1', port: 1, peerId: 'p1', machine: '同事的电脑' }
  addMember(store.state, {
    roomId: room.id,
    member: { id: 'm_mine_agent', kind: 'bot', name: 'backend-dev', botId: 'bot_backend', sessionId: null, origin: { kind: 'local' } },
  })
  const sent = []
  const runtime = { store, speaker: null, lan: { async announceAgents() {}, async send(args) { sent.push(args); return {} } } }
  const tool = createChatroomTool(runtime)
  const result = await tool.execute({ action: 'notify', room: '他的屋', as: 'backend-dev', text: '都对接完了。' }, { agent: { id: 'sess-mine' } })
  assert.match(result.message, /通知/)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].silent, true)
  assert.equal(sent[0].authorBotId, 'bot_backend')
})

test('发言调度：被 @ 的外部成员走它自己的会话，先等空闲再递话', async () => {
  const store = fakeStore()
  const room = createRoom(store.state, { name: '联调' })
  const external = addMember(store.state, {
    roomId: room.id,
    member: { id: 'm_ext_back', kind: 'bot', name: '旧登记', sessionId: 'sess-back', external: true },
  })
  const seen = []
  const runner = { async say(bot, prompt, options) { seen.push({ bot, prompt, options }); return { text: '好，我来接。' } } }
  const speaker = createSpeaker({ store, runner })
  const message = postMessage(store.state, { roomId: room.id, authorId: store.state.self.id, text: '@旧登记 你看下这个接口' })
  speaker.afterHumanMessage({ roomId: room.id, messageId: message.id })
  for (let i = 0; i < 200 && (store.state.rooms[0].messages.length < 2 || store.state.rooms[0].activity); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(seen.length, 1)
  assert.equal(seen[0].bot.sessionId, 'sess-back')
  assert.equal(seen[0].options.waitIdleFirst, true)
  assert.equal(store.state.rooms[0].messages.at(-1).authorId, external.id)
})

test('发言调度：external 目录行也先等空闲再递话', async () => {
  const store = fakeStore()
  const room = createRoom(store.state, { name: '联调' })
  const bot = { id: 'bot_ext', name: '后端', role: '', sessionId: 'sess-back', external: true, cwd: null, createdAt: '', lastError: null, lastSpokeAt: null }
  store.state.bots.push(bot)
  const member = addMember(store.state, { roomId: room.id, member: { id: 'm_' + bot.id, kind: 'bot', name: '后端', botId: bot.id, sessionId: bot.sessionId } })
  const seen = []
  const speaker = createSpeaker({ store, runner: { async say(target, prompt, options) { seen.push({ target, options }); return { text: '收到' } } } })
  const message = postMessage(store.state, { roomId: room.id, authorId: store.state.self.id, text: '@后端 看下' })
  speaker.afterHumanMessage({ roomId: room.id, messageId: message.id })
  for (let i = 0; i < 200 && (store.state.rooms[0].messages.length < 2 || store.state.rooms[0].activity); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(seen.length, 1)
  assert.equal(seen[0].target.id, 'bot_ext')
  assert.equal(seen[0].options.waitIdleFirst, true)
  assert.equal(store.state.rooms[0].messages.at(-1).authorId, member.id)
})

test('ask：@ 一个成员并拿回它的回复', async () => {
  const store = fakeStore()
  const room = createRoom(store.state, { name: '联调' })
  addLocalAgent(store, room, 'backend-dev', 'bot_backend')
  addLocalAgent(store, room, 'frontend-dev', 'bot_frontend')
  const runtime = {
    store,
    lan: null,
    speaker: {
      afterHumanMessage({ roomId }) {
        const live = store.state.rooms.find((row) => row.id === roomId)
        const target = live.members.find((member) => member.name === 'frontend-dev')
        store.commit(() => {
          postMessage(store.state, { roomId, authorId: target.id, text: '收到，接口我接了。' })
        })
      },
    },
  }
  const tool = createChatroomTool(runtime)
  const result = await tool.execute(
    { action: 'ask', room: '联调', as: 'backend-dev', to: ['frontend-dev'], text: '接口好了，你接一下', timeoutSec: 5 },
    { agent: { id: 'sess-mine' } },
  )
  assert.match(result.message, /frontend-dev/)
  assert.match(result.message, /收到，接口我接了/)
})

test('ask：没人回就按超时返回，且不能 @ 自己', async () => {
  const store = fakeStore()
  const room = createRoom(store.state, { name: '联调' })
  addLocalAgent(store, room, 'backend-dev', 'bot_backend')
  addLocalAgent(store, room, 'frontend-dev', 'bot_frontend')
  const tool = createChatroomTool(runtimeWith(store, []))
  await assert.rejects(
    () => tool.execute({ action: 'ask', room: '联调', as: 'backend-dev', to: ['backend-dev'], text: '自问' }, { agent: { id: 'sess-mine' } }),
    /就是你自己的身份/,
  )
  const started = Date.now()
  const result = await tool.execute(
    { action: 'ask', room: '联调', as: 'backend-dev', to: ['frontend-dev'], text: '在吗', timeoutSec: 1 },
    { agent: { id: 'sess-mine' } },
  )
  assert.match(result.message, /秒内没有回复/)
  assert.ok(Date.now() - started >= 900)
})

test('read：分页读取历史', async () => {
  const store = fakeStore()
  const room = createRoom(store.state, { name: '联调' })
  addLocalAgent(store, room, 'backend-dev', 'bot_backend')
  for (let i = 1; i <= 5; i += 1) {
    store.commit(() => {
      postMessage(store.state, { roomId: room.id, authorId: store.state.self.id, text: '第' + i + '条' })
    })
  }
  const tool = createChatroomTool(runtimeWith(store, []))
  const page1 = await tool.execute({ action: 'read', room: '联调', limit: 2 }, { agent: { id: 'sess-mine' } })
  assert.match(page1.message, /消息 4–5/)
  assert.match(page1.message, /beforeSeq=4/)
  const page2 = await tool.execute({ action: 'read', room: '联调', limit: 2, beforeSeq: 4 }, { agent: { id: 'sess-mine' } })
  assert.match(page2.message, /消息 2–3/)
})

test('clear：清空聊天记录，成员和规则保留', async () => {
  const store = fakeStore()
  const room = createRoom(store.state, { name: '联调' })
  addLocalAgent(store, room, 'backend-dev', 'bot_backend')
  const calls = []
  const tool = createChatroomTool(runtimeWith(store, calls))
  await tool.execute({ action: 'send', room: '联调', as: 'backend-dev', to: [], text: '一句话' }, { agent: { id: 'sess-mine' } })
  assert.equal(store.state.rooms[0].messages.length, 1)
  const membersBefore = store.state.rooms[0].members.length
  const result = await tool.execute({ action: 'clear', room: '联调' }, { agent: { id: 'sess-mine' } })
  assert.match(result.message, /清空/)
  assert.equal(store.state.rooms[0].messages.length, 0)
  assert.equal(store.state.rooms[0].members.length, membersBefore)
})

test('session：new 换新会话，continue 回到上一个', async () => {
  const store = fakeStore()
  const room = createRoom(store.state, { name: '联调' })
  addLocalAgent(store, room, 'backend-dev', 'bot_backend')
  const tool = createChatroomTool(runtimeWith(store, []))
  const bot = () => store.state.bots.find((b) => b.id === 'bot_backend')
  const original = bot().sessionId
  const fresh = await tool.execute({ action: 'session', room: '联调', as: 'backend-dev', mode: 'new' }, { agent: { id: 'sess-mine' } })
  assert.match(fresh.message, /新会话/)
  assert.notEqual(bot().sessionId, original)
  assert.equal(bot().external, false)
  const back = await tool.execute({ action: 'session', room: '联调', as: 'backend-dev', mode: 'continue' }, { agent: { id: 'sess-mine' } })
  assert.match(back.message, /回到上一个会话/)
  assert.equal(bot().sessionId, original)
})
