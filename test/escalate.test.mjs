import assert from 'node:assert/strict'
import test from 'node:test'
import { emptyState } from '../src/host/state.js'
import { addMember, createRoom, DEFAULT_RULES, postMessage, updateRoom } from '../src/host/rooms.js'
import { createSpeaker } from '../src/host/speak.js'

function fakeStore(state) {
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

function addBot(store, room, name, botId) {
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
    member: { id: 'm_' + botId, kind: 'bot', name, botId, sessionId: 'sess-' + name, origin: { kind: 'local' } },
  })
}

const settle = async (store) => {
  for (let i = 0; i < 200 && store.state.rooms[0].activity; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('流式草稿：pushStream 写进 activity.streaming，endStream 清掉', () => {
  const store = fakeStore(emptyState())
  const room = createRoom(store.state, { name: '联调' })
  const speaker = createSpeaker({ store, runner: { async say() { return { text: '' } } } })
  speaker.beginStream('sess-x', 'A', room.id)
  speaker.pushStream('sess-x', '你')
  assert.equal(store.state.rooms[0].activity.streaming.text, '你')
  speaker.pushStream('sess-x', '好') // 250ms 内被节流
  assert.equal(store.state.rooms[0].activity.streaming.text, '你')
  speaker.endStream('sess-x')
  assert.ok(!store.state.rooms[0].activity || !store.state.rooms[0].activity.streaming)
})

test('房间规则：默认自动讨论 3 轮，可配置且被夹在 1..10', () => {
  assert.equal(DEFAULT_RULES.maxAutoRounds, 3)
  const state = emptyState()
  const room = createRoom(state, { name: '联调' })
  updateRoom(state, { roomId: room.id, rules: { maxAutoRounds: 2 } })
  assert.equal(room.rules.maxAutoRounds, 2)
  updateRoom(state, { roomId: room.id, rules: { maxAutoRounds: 99 } })
  assert.equal(room.rules.maxAutoRounds, 10)
  updateRoom(state, { roomId: room.id, rules: { maxAutoRounds: 0 } })
  assert.equal(room.rules.maxAutoRounds, 1)
})

test('自动讨论到顶：@ 房主拍板并停手，人说话后重新计数', async () => {
  const state = emptyState()
  const room = createRoom(state, { name: '联调' })
  const a = addBot(fakeStore(state), room, 'A', 'bot_a')
  const b = addBot(fakeStore(state), room, 'B', 'bot_b')
  updateRoom(state, { roomId: room.id, rules: { maxAutoRounds: 1 } })
  const store = fakeStore(state)
  let calls = 0
  const speaker = createSpeaker({
    store,
    runner: {
      async say() {
        calls += 1
        return { text: '我这边先这样。' }
      },
    },
  })

  // 第 1 条 agent 消息：还有 1 轮预算，正常开跑
  const first = postMessage(state, { roomId: room.id, authorId: a.id, text: '@B 你的方案呢' })
  speaker.afterHumanMessage({ roomId: room.id, messageId: first.id })
  await settle(store)
  assert.equal(calls, 1)

  // 第 2 条 agent 消息：到顶，不再开跑，改为 @ 房主
  const beforeCount = state.rooms[0].messages.length
  const second = postMessage(state, { roomId: room.id, authorId: b.id, text: '我还是觉得不行。' })
  speaker.afterHumanMessage({ roomId: room.id, messageId: second.id })
  await settle(store)
  assert.equal(calls, 1, '到顶之后不该再跑模型')
  const escalateMsg = state.rooms[0].messages.at(-1)
  assert.match(escalateMsg.text, /自动讨论已达 1 轮上限/)
  assert.match(escalateMsg.text, /你定/)
  assert.match(escalateMsg.text, /@我/, '应该 @ 房主')

  // 再来的 agent 消息不会重复提醒
  const third = postMessage(state, { roomId: room.id, authorId: a.id, text: '嗯。' })
  speaker.afterHumanMessage({ roomId: room.id, messageId: third.id })
  await settle(store)
  assert.equal(state.rooms[0].messages.length, beforeCount + 3, '第三条 agent 消息照常落库，但不应再多出第二条提醒')
  const escalateCount = state.rooms[0].messages.filter((m) => /自动讨论已达/.test(m.text)).length
  assert.equal(escalateCount, 1, '同一串讨论只提醒一次')

  // 人说话：计数清零，可以重新讨论
  const human = postMessage(state, { roomId: room.id, authorId: state.self.id, text: '@A 你们继续' })
  speaker.afterHumanMessage({ roomId: room.id, messageId: human.id })
  await settle(store)
  assert.equal(calls, 2, '人说话后应该重新开轮')
})

for (const targetKind of ['local', 'lan', 'human']) {
  test('明确点名优先于主持人与全员规则：' + targetKind, async () => {
    const state = emptyState()
    const room = createRoom(state, { name: '点名' })
    const store = fakeStore(state)
    const chair = addBot(store, room, '主持人', 'chair')
    const target = targetKind === 'local' ? addBot(store, room, '目标', 'target') :
      addMember(state, { roomId: room.id, member: {
        id: 'target', name: '目标', kind: targetKind === 'human' ? 'human' : 'bot',
        owner: targetKind === 'lan' ? 'peer' : 'local', origin: { kind: targetKind === 'lan' ? 'lan' : 'local' },
      } })
    updateRoom(state, { roomId: room.id, rules: { chairId: chair.id, roundRobin: true } })
    const called = []
    const speaker = createSpeaker({ store,
      runner: { async say(bot) { called.push(bot.name); return { text: '收到' } } },
      dispatchRemote: async ({ member }) => { called.push(member.name); return { text: '收到' } },
    })
    const message = postMessage(state, { roomId: room.id, authorId: state.self.id, text: '@目标 在吗' })
    speaker.afterHumanMessage({ roomId: room.id, messageId: message.id })
    await settle(store)
    assert.deepEqual(called, targetKind === 'human' ? [] : ['目标'])
  })
}

test('单条消息上限真的执行：超长回复被截断，并提示下一条先给结论', async () => {
  const state = emptyState()
  const room = createRoom(state, { name: '长文' })
  const store = fakeStore(state)
  const bot = addBot(store, room, '后端', 'bot_long')
  updateRoom(state, { roomId: room.id, rules: { maxChars: 120 } })
  const long = '结论：可以。' + '细节'.repeat(200)
  const speaker = createSpeaker({ store, runner: { async say() { return { text: long } } } })
  await speaker.runRound({ roomId: room.id })
  const posted = state.rooms[0].messages.find((message) => message.authorId === bot.id)
  assert.ok(posted.text.length <= 120 + 20, '落库的消息不该超过上限')
  assert.match(posted.text, /已截断/)
})

test('同一条人消息重复进来，只驱动同一个 agent 一轮', async () => {
  const state = emptyState()
  const room = createRoom(state, { name: '去重' })
  const store = fakeStore(state)
  addBot(store, room, '后端', 'bot_dup')
  updateRoom(state, { roomId: room.id, rules: { roundRobin: true } })
  const called = []
  const speaker = createSpeaker({ store, runner: { async say(bot) { called.push(bot.name); return { text: '收到' } } } })
  const message = postMessage(state, { roomId: room.id, authorId: state.self.id, text: '在吗' })
  speaker.afterHumanMessage({ roomId: room.id, messageId: message.id })
  speaker.afterHumanMessage({ roomId: room.id, messageId: message.id })
  await settle(store)
  assert.deepEqual(called, ['后端'])
})

test('提示词：远程派发按收件人视角标「本机」，并要求先执行再回复', () => {
  const state = emptyState()
  const room = createRoom(state, { name: '视角' })
  const store = fakeStore(state)
  addBot(store, room, '本机agent', 'b_local')
  addMember(state, {
    roomId: room.id,
    member: { id: 'm_remote', kind: 'bot', name: '远程agent', role: '前端', botId: 'b_remote', origin: { kind: 'lan', peer: 'peer-1', machine: 'hm' } },
  })
  const speaker = createSpeaker({ store, runner: { async say() { return { text: '' } } } })
  const prompt = speaker.buildPrompt({
    room: state.rooms[0],
    bot: { id: 'm_remote', name: '远程agent' },
    at: 'mention',
    viewerPeer: 'peer-1',
  })
  assert.match(prompt, /远程agent（agent，前端，本机（你这台机器）/)
  assert.match(prompt, /本机agent（agent，宿主那台机器/)
  assert.match(prompt, /先动手|要处理的原文/)
})

test('提示词只带自己上次发言之后的记录，不带整间房的历史', () => {
  const state = emptyState()
  const room = createRoom(state, { name: '裁剪' })
  const store = fakeStore(state)
  const bot = addBot(store, room, '后端', 'b_clip')
  postMessage(state, { roomId: room.id, authorId: state.self.id, text: '很早以前的一句话' })
  postMessage(state, { roomId: room.id, authorId: bot.id, text: '我上次的答复' })
  postMessage(state, { roomId: room.id, authorId: state.self.id, text: '交给你的新任务' })
  const speaker = createSpeaker({ store, runner: { async say() { return { text: '' } } } })
  const prompt = speaker.buildPrompt({ room: state.rooms[0], bot: { id: bot.id, name: '后端' }, at: 'mention' })
  assert.match(prompt, /交给你的新任务/)
  assert.doesNotMatch(prompt, /很早以前的一句话/)
})

test('派发只传事实，由执行方自己拼提示词（加入方视角正确）', () => {
  const state = emptyState()
  const room = createRoom(state, { name: '事实' })
  const store = fakeStore(state)
  addBot(store, room, '宿主agent', 'b_host')
  addMember(state, {
    roomId: room.id,
    member: { id: 'm_peer', kind: 'bot', name: '对方agent', role: '前端', botId: 'b_peer', origin: { kind: 'lan', peer: 'peer-1', machine: 'hm' } },
  })
  const speaker = createSpeaker({ store, runner: { async say() { return { text: '' } } } })
  const facts = speaker.buildFacts({ room: state.rooms[0], bot: { id: 'm_peer', name: '对方agent', role: '前端' }, at: 'mention' })
  const own = speaker.promptFromFacts(facts, { selfKey: 'peer-1' })
  assert.match(own, /对方agent（agent，前端，本机（你这台机器）/)
  assert.match(own, /宿主agent（agent，宿主那台机器/)
  const hostView = speaker.promptFromFacts(facts, { selfKey: 'host' })
  assert.match(hostView, /宿主agent（agent，本机/)
})