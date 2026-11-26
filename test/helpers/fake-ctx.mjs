/**
 * 测 Host 半边用的假 ctx。
 *
 * 真的跑 apply(ctx) 的每一条接线（路由、信封、命令分发、agent 回合），
 * 只把「模型」和「文件系统」换成假的：这层测的是接线，不是模型。
 *
 * reply 可以按 prompt 定制，LAN 用例靠它区分「哪个 agent 被驱动了」。
 */

const encoder = new TextEncoder()

export function fakeCtx(dir, { reply, model = { provider: 'fake', model: 'fake-chat' }, workspaceRegistry, agentPresets } = {}) {
  const routes = new Map()
  const agents = new Map()
  const events = new Map()
  const prompts = []
  const creates = []
  const replyFor =
    typeof reply === 'function'
      ? reply
      : () => (typeof reply === 'string' ? reply : '我看了现金流，数字对得上。')

  function agentFor(sessionId) {
    const session = { id: sessionId, seq: 0, header: {} }
    return {
      session,
      status: 'idle',
      followup(message) {
        const text = message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
        prompts.push({ sessionId, text, message })
        const list = events.get(sessionId) ?? []
        list.push({
          seq: list.length + 1,
          type: 'assistant/message',
          data: {
            interrupted: false,
            message: {
              id: `a${list.length + 1}`,
              role: 'assistant',
              content: [{ type: 'text', text: String(replyFor(text, sessionId)) }],
            },
          },
        })
        events.set(sessionId, list)
        session.seq = list.length
      },
      whenIdle: async () => {},
    }
  }

  const services = {
    agents: {
      get: (id) => agents.get(id),
      create: async (input) => {
        creates.push(input)
        if (typeof input.setup === 'function') await input.setup({})
        const agent = agentFor(input.sessionId)
        agents.set(input.sessionId, agent)
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
    agentDefaultModel: { currentSelection: () => model },
    workingDirectory: { defaultDirectory: dir },
    ...(workspaceRegistry ? { workspaceRegistry } : {}),
    ...(agentPresets ? { agentPresets } : {}),
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
  ctx.root = ctx
  return { ctx, routes, promises: prompts, prompts, events, creates }
}

export function request(payload, method = 'dsh.chatroom/command') {
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

export async function call(routes, endpoint, payload) {
  const route = routes.get(`/api/dsh.chatroom/${endpoint}`)
  if (!route) throw new Error(`路由 ${endpoint} 没有注册`)
  const response = await route.fetch(request(payload, `dsh.chatroom/${endpoint}`))
  const body = await response.json()
  if (body.type !== 'server-response') throw new Error('回应不是 server-response 信封')
  return body.result
}

/** 等一个条件成立：房间里的 agent 回复是异步补进来的，测试得等它落库。 */
export async function until(check, { timeoutMs = 4000, stepMs = 40, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

export const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))
