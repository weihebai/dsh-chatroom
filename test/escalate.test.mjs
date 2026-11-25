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
  assert.match(escalateMsg.text, /自动讨论已经进行 1 轮/)
  assert.match(escalateMsg.text, /请你拍板/)
  assert.match(escalateMsg.text, /@我/, '应该 @ 房主')

  // 再来的 agent 消息不会重复提醒
  const third = postMessage(state, { roomId: room.id, authorId: a.id, text: '嗯。' })
  speaker.afterHumanMessage({ roomId: room.id, messageId: third.id })
  await settle(store)
  assert.equal(state.rooms[0].messages.length, beforeCount + 3, '第三条 agent 消息照常落库，但不应再多出第二条提醒')
  const escalateCount = state.rooms[0].messages.filter((m) => /自动讨论已经进行/.test(m.text)).length
  assert.equal(escalateCount, 1, '同一串讨论只提醒一次')

  // 人说话：计数清零，可以重新讨论
  const human = postMessage(state, { roomId: room.id, authorId: state.self.id, text: '@A 你们继续' })
  speaker.afterHumanMessage({ roomId: room.id, messageId: human.id })
  await settle(store)
  assert.equal(calls, 2, '人说话后应该重新开轮')
})
