import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/host/plugin.js'

/**
 * Host 半边的端到端测试：真的跑 apply(ctx)，真的过一遍路由、信封、命令分发、
 * Bot 回合，只是把「模型」和「文件系统」换成假的。
 *
 * 这层测的是接线，而不是模型：一条人消息进来，@ 到的 agent 必须真的被驱动一轮，
 * 它的回复必须按 seq 落进房间并出现在下一个 snapshot 里。
 */

const encoder = new TextEncoder()

// LAN 监听在 apply() 里就会起来；测试用系统挑的空闲端口，不去抢本机宿主的 4399。
process.env.DSH_CHATROOM_PORT = '0'

const DEFAULT_REPLY = '我看了现金流，数字对得上。'

function fakeCtx(dir, { reply = DEFAULT_REPLY, gate = null } = {}) {
  const routes = new Map()
  const agents = new Map()
  const events = new Map()
  const prompts = []

  function agentFor(sessionId) {
    const session = { id: sessionId, seq: 0, header: {} }
    const agent = {
      session,
      status: 'idle',
      followup(message) {
        const text = message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
        prompts.push({ sessionId, text, message })
        const answer = typeof reply === 'function' ? reply(text) : reply
        // reply 可以直接返回 { interrupted: true }：用来模拟「这一轮跑完了但没留下话」，
        // 真实场景是用户点了「停下这一轮」。
        const shaped = answer && typeof answer === 'object' ? answer : { text: answer }
        const list = events.get(sessionId) ?? []
        list.push({
          seq: list.length + 1,
          type: 'assistant/message',
          data: {
            interrupted: shaped.interrupted === true,
            message: {
              id: 'a' + (list.length + 1),
              role: 'assistant',
              content: shaped.text ? [{ type: 'text', text: shaped.text }] : [],
            },
          },
        })
        events.set(sessionId, list)
        session.seq = list.length
      },
      // gate 让测试能把「这一轮还在跑」这个时间窗拉长到可以操作，否则假模型瞬间就跑完了。
      // 被 abort 时必须跟真 turn.js 一样抛 cancelled：用户点「停下这一轮」走的就是这条路。
      whenIdle: async (signal) => {
        if (typeof gate !== 'function') return
        const waiting = gate()
        if (!signal) return waiting
        await Promise.race([
          waiting,
          new Promise((_, reject) => {
            const stop = () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }))
            if (signal.aborted) stop()
            else signal.addEventListener('abort', stop, { once: true })
          }),
        ])
      },
    }
    return agent
  }

  const services = {
    agents: {
      get: (id) => agents.get(id),
      create: async ({ sessionId }) => {
        const agent = agentFor(sessionId)
        agents.set(sessionId, agent)
        return { agent }
      },
      resume: async () => {
        throw Object.assign(new Error('no persisted session'), { code: 'session_not_found' })
      },
      roots: () => [],
    },
    sessions: { flush: async () => {} },
    sessionPersistence: {
      open: async (sessionId) => ({
        read: async () => ({ events: events.get(sessionId) ?? [] }),
        close: async () => {},
      }),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-chat' }) },
    workingDirectory: { defaultDirectory: dir },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
  }

  const ctx = {
    profileContext: { name: 'test', dir },
    get: (key) => services[key],
    effect: (fn) => fn(),
  }
  return { ctx, routes, prompts, events }
}

function request(payload, method = 'dsh.chatroom/command') {
  const body = encoder.encode(JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method, payload }))
  return {
    method: 'POST',
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : undefined) },
    signal: new AbortController().signal,
    body: {
      getReader() {
        let sent = false
        return {
          async read() {
            if (sent) return { done: true, value: undefined }
            sent = true
            return { done: false, value: body }
          },
          releaseLock() {},
        }
      },
    },
  }
}

async function call(routes, endpoint, payload) {
  const route = routes.get(`/api/dsh.chatroom/${endpoint}`)
  assert.ok(route, `路由 ${endpoint} 应该已注册`)
  const response = await route.fetch(request(payload, `dsh.chatroom/${endpoint}`))
  const body = await response.json()
  assert.equal(body.type, 'server-response')
  return body.result
}

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

test('四个端点都注册，快照是空房间列表', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  const { ctx, routes } = fakeCtx(dir)
  const dispose = await apply(ctx)
  try {
    for (const endpoint of ['snapshot', 'command', 'messages', 'watch']) {
      assert.ok(routes.has(`/api/dsh.chatroom/${endpoint}`), `缺少 ${endpoint}`)
    }
    const snapshot = await call(routes, 'snapshot', {})
    assert.equal(snapshot.ok, true)
    assert.deepEqual(snapshot.value.rooms, [])
    assert.equal(snapshot.value.self.id, 'me')
  } finally {
    await dispose()
  }
})

test('建房间 → 加 agent → 人发言 @ 它 → agent 真的被驱动并按 seq 落进房间', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  const { ctx, routes, prompts } = fakeCtx(dir)
  const dispose = await apply(ctx)
  try {
    const created = await call(routes, 'command', { action: 'room.create', input: { name: '周四投委会', topic: '看财报' } })
    assert.equal(created.ok, true)
    const roomId = created.value.rooms[0].id
    assert.match(created.value.rooms[0].code, /^[2-9A-HJ-NP-Z]{6}$/)

    const withBot = await call(routes, 'command', {
      action: 'member.createBot',
      input: { roomId, name: 'Claude', role: '看财报的' },
    })
    assert.equal(withBot.ok, true)
    assert.equal(withBot.value.rooms[0].members.filter((m) => m.kind === 'bot').length, 1)

    const sent = await call(routes, 'command', {
      action: 'msg.send',
      input: { roomId, text: '@Claude 现金流那行对不对？' },
    })
    assert.equal(sent.ok, true)
    // 人那条立刻可见，agent 那条是异步补进来的
    assert.equal(sent.value.rooms[0].messages.length, 1)
    assert.equal(sent.value.rooms[0].messages[0].authorId, 'me')

    await tick(200)

    const after = await call(routes, 'snapshot', {})
    const room = after.value.rooms[0]
    assert.equal(room.messages.length, 2, 'agent 应该回了一句')
    const reply = room.messages[1]
    assert.equal(reply.authorName, 'Claude')
    assert.equal(reply.authorKind, 'bot')
    assert.equal(reply.seq, 2)
    assert.match(reply.text, /现金流/)
    assert.equal(room.activity, null, '这一轮结束后不该还挂着发言中')

    assert.equal(prompts.length, 1, 'agent 应该只被驱动一次')
    assert.match(prompts[0].text, /@Claude 现金流那行对不对？/, '房间上下文要进 prompt')
    assert.match(prompts[0].text, /周四投委会/)
    assert.equal(prompts[0].message.role, 'user', '必须是 user 角色消息')
  } finally {
    await dispose()
  }
})

test('agent 的名字和职责能改：改的是同一个 agent，两间屋子一起换，@ 认新名字、职责进 prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  const { ctx, routes, prompts } = fakeCtx(dir)
  const dispose = await apply(ctx)
  try {
    const first = await call(routes, 'command', { action: 'room.create', input: { name: '对账屋' } })
    const roomId = first.value.rooms[0].id
    await call(routes, 'command', { action: 'member.createBot', input: { roomId, name: 'Claude', role: '' } })
    // 同一个 agent 再进第二间屋子：名字与职责属于 agent 本身，改一次两边都该跟着换。
    const second = await call(routes, 'command', { action: 'room.create', input: { name: '复盘屋' } })
    const secondRoomId = second.value.rooms.find((room) => room.id !== roomId).id
    const botId = (await call(routes, 'snapshot', {})).value.bots[0].id
    await call(routes, 'command', { action: 'member.addBot', input: { roomId: secondRoomId, botId } })

    const updated = await call(routes, 'command', {
      action: 'bot.update',
      input: { botId, name: '账期 agent', role: '盯 45 天账期与返点' },
    })
    assert.equal(updated.ok, true, JSON.stringify(updated.error))

    const snap = (await call(routes, 'snapshot', {})).value
    assert.equal(snap.bots.length, 1, '改名不该凭空多出一个 agent')
    assert.equal(snap.bots[0].name, '账期 agent')
    assert.equal(snap.bots[0].role, '盯 45 天账期与返点')
    for (const room of snap.rooms) {
      const member = room.members.find((row) => row.botId === botId)
      assert.ok(member, `${room.name} 里应该还有这个 agent`)
      assert.equal(member.name, '账期 agent')
      assert.equal(member.role, '盯 45 天账期与返点')
    }

    // 名字换了，@ 就得认新名字；职责也要真的进 prompt（它决定这个 agent 怎么说话）。
    await call(routes, 'command', { action: 'msg.send', input: { roomId, text: '@账期 agent 这周的数出来了吗？' } })
    await tick(200)
    assert.equal(prompts.length, 1, '新名字应该能 @ 到它')
    assert.match(prompts[0].text, /你的职责：盯 45 天账期与返点/)

    // 旧名字不该还能触发：认的是成员当前的名字，不是历史署名。
    await call(routes, 'command', { action: 'msg.send', input: { roomId, text: '@Claude 你还记得吗？' } })
    await tick(200)
    assert.equal(prompts.length, 1, '旧名字不该再驱动这个 agent')
  } finally {
    await dispose()
  }
})

test('没被 @ 也没开全员轮次时，agent 不发言（不白烧模型调用）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  const { ctx, routes, prompts } = fakeCtx(dir)
  const dispose = await apply(ctx)
  try {
    const created = await call(routes, 'command', { action: 'room.create', input: { name: '安静点' } })
    const roomId = created.value.rooms[0].id
    await call(routes, 'command', { action: 'member.createBot', input: { roomId, name: 'Grok' } })
    await call(routes, 'command', { action: 'msg.send', input: { roomId, text: '今天先不聊' } })
    await tick(120)
    assert.equal(prompts.length, 0)
    const after = await call(routes, 'snapshot', {})
    assert.equal(after.value.rooms[0].messages.length, 1)
  } finally {
    await dispose()
  }
})

test('「让全员说一轮」不靠 @ 也会让所有 agent 各说一句', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  const { ctx, routes, prompts } = fakeCtx(dir)
  const dispose = await apply(ctx)
  try {
    const created = await call(routes, 'command', { action: 'room.create', input: { name: '全员发言' } })
    const roomId = created.value.rooms[0].id
    await call(routes, 'command', { action: 'member.createBot', input: { roomId, name: 'A' } })
    await call(routes, 'command', { action: 'member.createBot', input: { roomId, name: 'B' } })
    await call(routes, 'command', { action: 'msg.send', input: { roomId, text: '每人一句' } })
    const round = await call(routes, 'command', { action: 'round.run', input: { roomId } })
    assert.equal(round.ok, true)
    await tick(250)
    const after = await call(routes, 'snapshot', {})
    assert.equal(after.value.rooms[0].messages.length, 3, '人 1 条 + 两个 agent 各 1 条')
    assert.equal(prompts.length, 2)
  } finally {
    await dispose()
  }
})

/** prompt 里的「以「X」的身份」就是这一轮被驱动的 agent。 */
const speakerOf = (text) => text.match(/以「(.+?)」的身份/)?.[1] ?? null

const botsOf = (snapshot) => snapshot.value.rooms[0].members.filter((member) => member.kind === 'bot')

test('三条规则同时开：主持人 @ 的人不会被再调度一次，全员轮次仍然轮到每个人', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  // 主持人先说话，并在回复里 @B —— 这是「chair 接力」和「全员轮流」撞在一起的那条路。
  const { ctx, routes, prompts } = fakeCtx(dir, {
    reply: (text) =>
      text.includes('主持人')
        ? '现金流这块我先定调：没问题。@B 你把成本那部分补一下。'
        : '我补一句：这版数字能对上。',
  })
  const dispose = await apply(ctx)
  try {
    const created = await call(routes, 'command', { action: 'room.create', input: { name: '三条规则同时开' } })
    const roomId = created.value.rooms[0].id
    for (const name of ['A', 'B', 'C']) {
      await call(routes, 'command', { action: 'member.createBot', input: { roomId, name, role: '参谋' } })
    }
    const listed = await call(routes, 'snapshot', {})
    const bots = botsOf(listed)
    const chair = bots.find((member) => member.name === 'A')
    // 三条规则一起开，预算留够 4 个回合：扣掉「同一个人不许说两遍」，三个人正好各一次。
    const updated = await call(routes, 'command', {
      action: 'room.update',
      input: { roomId, rules: { mention: true, roundRobin: true, chairId: chair.id, maxSpeakers: 4 } },
    })
    assert.equal(updated.value.rooms[0].rules.roundRobin, true)
    assert.equal(updated.value.rooms[0].rules.mention, true)
    assert.equal(updated.value.rooms[0].rules.chairId, chair.id)

    await call(routes, 'command', { action: 'msg.send', input: { roomId, text: '请主持人组织大家各说一句' } })
    await tick(400)

    const after = await call(routes, 'snapshot', {})
    const replies = after.value.rooms[0].messages.filter((message) => message.authorKind === 'bot')
    const said = replies.map((message) => message.authorName)
    assert.deepEqual(said.slice().sort(), ['A', 'B', 'C'], `每个 agent 只能说一次，实际：${said.join('、')}`)
    assert.equal(prompts.length, 3, `只该驱动三轮回合，实际驱动了 ${prompts.length} 轮`)
    const driven = prompts.map((prompt) => speakerOf(prompt.text))
    assert.deepEqual(driven.slice().sort(), ['A', 'B', 'C'], `被驱动的应该恰好是三个人，实际：${driven.join('、')}`)
    assert.equal(after.value.rooms[0].activity, null, '这一轮结束后不该还挂着发言中')
  } finally {
    await dispose()
  }
})

test('正在发言时人又说了一句：这句不会被吞掉，等这一轮结束就接上', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  let release = () => {}
  let open = false
  const held = new Promise((resolve) => {
    release = () => {
      open = true
      resolve()
    }
  })
  // 把「一轮还没跑完」这个窗口撑开：真实房间里它有好几秒，用户正是在这时候插话。
  const { ctx, routes, prompts } = fakeCtx(dir, { gate: async () => (open ? null : held) })
  const dispose = await apply(ctx)
  try {
    const created = await call(routes, 'command', { action: 'room.create', input: { name: '插话' } })
    const roomId = created.value.rooms[0].id
    for (const name of ['A', 'B']) {
      await call(routes, 'command', { action: 'member.createBot', input: { roomId, name } })
    }
    await call(routes, 'command', { action: 'room.update', input: { roomId, rules: { roundRobin: true } } })

    await call(routes, 'command', { action: 'msg.send', input: { roomId, text: '每人一句' } })
    await tick(80)
    assert.equal(prompts.length, 1, '这一轮应该已经开始（第一句卡在 gate 上）')

    // 这一句发在别人发言中间：它必须被记下来，而不是静默丢掉。
    const interjected = await call(routes, 'command', {
      action: 'msg.send',
      input: { roomId, text: '@B 你等会儿单独说一句' },
    })
    const interjectedSeq = interjected.value.rooms[0].messages.find((message) => message.authorKind === 'human' && message.text.includes('单独说一句'))?.seq
    assert.ok(interjectedSeq, '人那句本身应该已经落进房间')

    release()
    await tick(600)

    const after = await call(routes, 'snapshot', {})
    // 第一轮是 A、B 各一句；插话明确点名 B，只再叫 B。
    assert.equal(prompts.length, 3, '点名插话只再驱动 B，不追加全员')
    assert.deepEqual(prompts.map((prompt) => speakerOf(prompt.text)), ['A', 'B', 'B'])
    assert.match(prompts[2].text, /@B 你等会儿单独说一句/, '接上的那一轮要带上插话本身')

    const replied = after.value.rooms[0].messages.filter(
      (message) => message.authorKind === 'bot' && message.seq > interjectedSeq && message.authorName === 'B',
    )
    // 一句是这一轮自己的台词（排队排在插话后面），一句是插话换来的。
    assert.equal(replied.length, 2)
    assert.equal(after.value.rooms[0].activity, null)
  } finally {
    await dispose()
  }
})

test('每个 agent 有自己的原生会话：两轮之后各回各的会话，互不串台', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  // 回复里带上「这一轮是谁在说」：只要会话串了，这句就会出现在别人的会话里。
  const { ctx, routes, prompts, events } = fakeCtx(dir, {
    reply: (text) => `我是${speakerOf(text)}，这是我的原话。`,
  })
  const dispose = await apply(ctx)
  try {
    const created = await call(routes, 'command', { action: 'room.create', input: { name: '各说各的' } })
    const roomId = created.value.rooms[0].id
    for (const name of ['A', 'B']) {
      await call(routes, 'command', { action: 'member.createBot', input: { roomId, name } })
    }
    const listed = (await call(routes, 'snapshot', {})).value
    const bots = listed.rooms[0].members.filter((member) => member.kind === 'bot')
    const sessionOf = Object.fromEntries(bots.map((member) => [member.name, member.sessionId]))
    assert.ok(sessionOf.A && sessionOf.B, '每个 agent 都该有自己的 sessionId')
    assert.notEqual(sessionOf.A, sessionOf.B, '两个 agent 不能共用一个原生会话')

    await call(routes, 'command', { action: 'room.update', input: { roomId, rules: { roundRobin: true } } })
    // 连着两轮全员发言：同一个 agent 第二次开口必须回到它自己那个会话上。
    for (const text of ['第一轮', '第二轮']) {
      await call(routes, 'command', { action: 'msg.send', input: { roomId, text } })
      await call(routes, 'command', { action: 'round.run', input: { roomId } })
      await tick(250)
    }

    assert.equal(prompts.length, 4, `两轮各两个人，应该驱动四次，实际 ${prompts.length} 次`)
    for (const [name, sessionId] of Object.entries(sessionOf)) {
      const driven = prompts.filter((prompt) => speakerOf(prompt.text) === name)
      assert.equal(driven.length, 2, `${name} 应该被驱动两次`)
      assert.deepEqual(
        driven.map((prompt) => prompt.sessionId),
        [sessionId, sessionId],
        `${name} 的两轮必须落在同一个原生会话里`,
      )
      // 记忆就是会话历史：它那个会话里只该有它自己说过的话。
      const own = events.get(sessionId) ?? []
      assert.equal(own.length, 2, `${name} 的会话里应该正好两句`)
      for (const event of own) {
        const said = event.data.message.content.map((block) => block.text).join('')
        assert.match(said, new RegExp(`我是${name}，`), `${name} 的会话里不该出现别人的话：${said}`)
      }
    }
  } finally {
    await dispose()
  }
})

test('这一轮没留下话（被中断）时，不会把上一条再当成新话发一遍', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  const { ctx, routes } = fakeCtx(dir, {
    reply: (text) => (text.includes('第二句') ? { interrupted: true } : '第一句的回答：数字对得上。'),
  })
  const dispose = await apply(ctx)
  try {
    const created = await call(routes, 'command', { action: 'room.create', input: { name: '说到一半停下' } })
    const roomId = created.value.rooms[0].id
    await call(routes, 'command', { action: 'member.createBot', input: { roomId, name: 'A' } })

    await call(routes, 'command', { action: 'msg.send', input: { roomId, text: '@A 第一句' } })
    await tick(200)
    let room = (await call(routes, 'snapshot', {})).value.rooms[0]
    assert.equal(room.messages.length, 2, '第一轮应该有问有答')

    await call(routes, 'command', { action: 'msg.send', input: { roomId, text: '@A 第二句' } })
    await tick(250)
    room = (await call(routes, 'snapshot', {})).value.rooms[0]

    const repeated = room.messages.filter((message) => message.text.includes('第一句的回答'))
    assert.equal(repeated.length, 1, `上一句不该再发一遍，实际出现 ${repeated.length} 次`)
    assert.equal(room.messages.at(-1).status, 'error', '这一轮该以「没回上来」收尾，而不是假装说了句新的')
    assert.match(room.messages.at(-1).text, /没回上来/)
  } finally {
    await dispose()
  }
})

test('agent 没回上来时，可以只重试它一个：不惊动别人、也不换会话', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  let turns = 0
  const { ctx, routes, prompts } = fakeCtx(dir, {
    reply: () => {
      turns += 1
      // 第一次真挂（同步抛出，走的是和真实模型报错同一条路径），第二次正常说话。
      if (turns === 1) throw Object.assign(new Error('模型这一轮挂了'), { code: 'model_failed' })
      return '回来了：缺口 31 万。'
    },
  })
  const dispose = await apply(ctx)
  const settle = async (check, label) => {
    for (let i = 0; i < 60; i += 1) {
      const hit = await check()
      if (hit) return hit
      await tick(50)
    }
    throw new Error(`等待超时：${label}`)
  }
  try {
    const created = await call(routes, 'command', { action: 'room.create', input: { name: '重试一次' } })
    const roomId = created.value.rooms[0].id
    for (const name of ['A', 'B']) {
      await call(routes, 'command', { action: 'member.createBot', input: { roomId, name } })
    }

    await call(routes, 'command', { action: 'msg.send', input: { roomId, text: '@A 报一下缺口。' } })
    const failed = await settle(async () => {
      const room = (await call(routes, 'snapshot', {})).value.rooms[0]
      return room.messages.find((message) => message.status === 'error') ?? null
    }, 'A 这一轮失败')
    assert.match(failed.text, /没回上来/, '失败要留在房里当占位，不能悄悄没了')
    assert.equal(prompts.length, 1, '@ 只点到 A，B 不该被驱动')

    const retried = await call(routes, 'command', { action: 'msg.retry', input: { roomId, seq: failed.seq } })
    assert.equal(retried.ok, true, `重试该被接受：${JSON.stringify(retried.error)}`)
    const replied = await settle(async () => {
      const room = (await call(routes, 'snapshot', {})).value.rooms[0]
      return room.messages.find((message) => message.text === '回来了：缺口 31 万。') ?? null
    }, 'A 重试后落库')
    assert.equal(replied.authorName, 'A')
    assert.equal(prompts.length, 2, '只该把 A 再跑一次，别把屋里其他人也带上')
    assert.equal(prompts[0].sessionId, prompts[1].sessionId, '重试要回到 A 自己那个原生会话')
    // 失败的占位留在历史里，成功那条接在后面：这一轮确实失败过，不该抹掉。
    assert.equal(
      (await call(routes, 'snapshot', {})).value.rooms[0].messages.filter((message) => message.status === 'error').length,
      1,
    )

    // 人说的话没有「重说」这回事：重试只对 agent 的回合有意义。
    const mine = (await call(routes, 'snapshot', {})).value.rooms[0].messages.find((message) => message.authorKind === 'human')
    const refused = await call(routes, 'command', { action: 'msg.retry', input: { roomId, seq: mine.seq } })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'not_agent_message')
  } finally {
    await dispose()
  }
})

test('信封不合法直接 400，不会把垃圾当成命令', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  const { ctx, routes } = fakeCtx(dir)
  const dispose = await apply(ctx)
  try {
    const route = routes.get('/api/dsh.chatroom/command')
    const bad = {
      method: 'POST',
      headers: { get: () => 'application/json' },
      signal: new AbortController().signal,
      body: {
        getReader() {
          const body = encoder.encode(JSON.stringify({ hello: 'world' }))
          let sent = false
          return {
            async read() {
              if (sent) return { done: true, value: undefined }
              sent = true
              return { done: false, value: body }
            },
            releaseLock() {},
          }
        },
      },
    }
    const response = await route.fetch(bad)
    assert.equal(response.status, 400)
  } finally {
    await dispose()
  }
})

test('未知命令返回可读错误而不是把进程带崩', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  const { ctx, routes } = fakeCtx(dir)
  const dispose = await apply(ctx)
  try {
    const result = await call(routes, 'command', { action: 'rm -rf /', input: {} })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'unknown_action')
  } finally {
    await dispose()
  }
})

test('watch：revision 变了立刻返回，没变就等到超时', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  const { ctx, routes } = fakeCtx(dir)
  const dispose = await apply(ctx)
  try {
    const snapshot = await call(routes, 'snapshot', {})
    // since 落后 → 立即返回
    const immediate = await call(routes, 'watch', { since: snapshot.value.revision - 1 })
    assert.equal(immediate.ok, true)
  } finally {
    await dispose()
  }
})

test('房间说到一半被解散：那一轮安静收掉，不把 agent 记成「上次失败」', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { ctx, routes } = fakeCtx(dir, { reply: '这句话没人看见了。', gate: () => gate })
  const dispose = await apply(ctx)
  try {
    const created = await call(routes, 'command', { action: 'room.create', input: { name: '说到一半被解散' } })
    const roomId = created.value.rooms[0].id
    const made = await call(routes, 'command', { action: 'member.createBot', input: { roomId, name: 'A' } })
    const botId = made.value.bots.at(-1).id
    await call(routes, 'command', { action: 'msg.send', input: { roomId, text: '@A 说一句' } })
    // 这一轮已经跑起来了（agent 正卡在 gate 上），此时把屋子解散掉。
    await tick(120)
    const dissolved = await call(routes, 'command', { action: 'room.dissolve', input: { roomId } })
    assert.equal(dissolved.ok, true)
    release()
    await tick(300)

    const view = (await call(routes, 'snapshot', {})).value
    assert.equal(view.rooms.some((row) => row.id === roomId), false, '屋子确实没了')
    const bot = view.bots.find((row) => row.id === botId)
    assert.equal(
      bot.lastError ?? null,
      null,
      '屋子解散不是这个 agent 的错：不该把 room_not_found/cancelled 记成它的上次失败',
    )
  } finally {
    release()
    await dispose()
  }
})

test('「停下这一轮」是真的停住：后面的人不再发言，也不留一条红色「没回上来」', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { ctx, routes, prompts } = fakeCtx(dir, { reply: '这句话不该出现在屋里。', gate: () => gate })
  const dispose = await apply(ctx)
  try {
    const created = await call(routes, 'command', { action: 'room.create', input: { name: '停一下' } })
    const roomId = created.value.rooms[0].id
    for (const name of ['A', 'B', 'C']) {
      await call(routes, 'command', { action: 'member.createBot', input: { roomId, name } })
    }
    // 全员轮流：谁也不 @，A、B、C 都该轮到。
    await call(routes, 'command', {
      action: 'room.update',
      input: { roomId, rules: { roundRobin: true, maxSpeakers: 3 } },
    })
    await call(routes, 'command', { action: 'msg.send', input: { roomId, text: '各自说说手上那件事' } })
    // A 正卡在「模型还没回」上，这时候点停下 —— 真实房间里用户就是在这时候点的。
    await tick(150)
    const running = (await call(routes, 'snapshot', {})).value
    assert.equal(running.rooms[0].activity?.speaking?.length, 1, '先得真的有一轮在跑，不然这条测不到东西')
    const stopped = await call(routes, 'command', { action: 'round.stop', input: { roomId } })
    assert.equal(stopped.ok, true)
    release()
    await tick(500)

    const view = (await call(routes, 'snapshot', {})).value
    const room = view.rooms[0]
    assert.equal(
      room.messages.filter((message) => message.status === 'error').length,
      0,
      '停下不是失败：屋里不该留「X 这次没回上来：cancelled」',
    )
    assert.equal(prompts.length, 1, '停下之后 B、C 不该再被驱动')
    assert.equal(
      view.bots.filter((bot) => bot.lastError).length,
      0,
      '停下不是这个 agent 的错，不该记成它的「上次失败」',
    )
    assert.equal(room.activity ?? null, null, '停下之后不该还挂着「正在说」')
  } finally {
    release()
    await dispose()
  }
})

test('停下之后马上接着说：旧回合的收尾不会把新的一轮也收掉', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-'))
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let gated = true
  const { ctx, routes } = fakeCtx(dir, {
    reply: '收到，我这边清楚。',
    gate: () => (gated ? gate : Promise.resolve()),
  })
  const dispose = await apply(ctx)
  try {
    const created = await call(routes, 'command', { action: 'room.create', input: { name: '停完再接上' } })
    const roomId = created.value.rooms[0].id
    const made = await call(routes, 'command', { action: 'member.createBot', input: { roomId, name: 'A' } })
    const botId = made.value.bots.at(-1).id
    await call(routes, 'command', { action: 'msg.send', input: { roomId, text: '@A 先说一句' } })
    await tick(150)
    await call(routes, 'command', { action: 'round.stop', input: { roomId } })
    // 用户停完立刻又说了句新的：这一轮必须照常跑完并落库。
    gated = false
    release()
    await tick(120)
    await call(routes, 'command', { action: 'msg.send', input: { roomId, text: '@A 那就说这件' } })
    await tick(500)

    const view = (await call(routes, 'snapshot', {})).value
    const room = view.rooms[0]
    const said = room.messages.filter((message) => message.authorKind === 'bot')
    assert.equal(said.length, 1, '新的一轮该有一句回复')
    assert.equal(said[0].status, 'sent')
    assert.equal(room.messages.filter((message) => message.status === 'error').length, 0)
    assert.equal(room.activity ?? null, null, '跑完了就该收干净')
    assert.equal(view.bots.find((bot) => bot.id === botId).lastError ?? null, null)
  } finally {
    release()
    await dispose()
  }
})
