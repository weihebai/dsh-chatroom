import { randomUUID } from 'node:crypto'

/**
 * Bot 回合驱动：把「某个 agent 说一句话」变成一个可等待的函数。
 *
 * 走的是 DSH 自己的原生会话，不是另起一个模型调用：
 *   1. 拿到（或建出）这个 Bot 的原生 Session 对应的 Agent；
 *   2. `agent.followup(createUserMessage(...))` 把房间里的上下文作为一条用户消息递进去；
 *   3. `agent.whenIdle()` 等这一轮跑完；
 *   4. 从会话持久化里读回最后一条 assistant 消息的文本。
 *
 * 这么做换来两件事：每个 Bot 的记忆天然就是它自己的会话历史（关掉 DSH 也在），
 * 以及消息、用量、审批都还归 DSH 自己管——插件不绕过宿主的权限模型。
 */

/**
 * 用户消息的形状与 @deepseek-ai/dsh-llm 的 createUserMessage 完全一致：
 *   { id, role:'user', content:[{type:'text',text}], source }
 * 自己拼而不 import 那个包，理由同 plugin.js 里的信封校验：插件必须自包含。
 */
function userMessage({ content, source }) {
  return { id: randomUUID(), role: 'user', content, source }
}

const textOf = (event) =>
  event?.data?.message?.content
    ?.filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim() ?? ''

const replyOf = (events) =>
  events
    .filter((event) => event.type === 'assistant/message' && !event?.data?.interrupted && textOf(event))
    .at(-1) ?? null

const fail = (code, message) => {
  throw Object.assign(new Error(message ?? code), { code })
}

export function createBotRunner(ctx, { log = () => {} } = {}) {
  /** sessionId → agent：同一进程里复用，避免每次都 resume。 */
  const agents = new Map()
  /** sessionId → 最近一次真正发进房间的那条回复的消息 id，用来分辨「这一轮到底有没有新话」。 */
  const posted = new Map()

  const idOf = (reply) => reply?.data?.message?.id ?? null

  // 建会话、挂 preset 必须走 root 上下文：走插件自己的 fiber 时 preset 的激活审计
  // 会失败（隔离域不同），会话建出来能用但没有工具。
  const rootCtx = () => ctx.root ?? ctx

  function requireService(key) {
    const root = rootCtx()
    const service = root.get?.(key) ?? root[key] ?? ctx.get?.(key) ?? ctx[key]
    if (!service) fail(`${key}_unavailable`, `DSH 服务 ${key} 不可用，无法让 agent 发言。`)
    return service
  }

  function modelSelection() {
    const service = ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel
    try {
      const selection = service?.currentSelection?.()
      if (selection && typeof selection === 'object') return selection
    } catch (error) {
      log('model-selection-failed', error)
    }
    return {}
  }

  /**
   * 把新建的会话挂到它目录所属的工作区。
   *
   * 侧边栏的分组存在 workspace 记录的 sessionIds 上，不是会话头的字段：
   * 网页端每打开一个会话都会挂一次，而 `agents.create` 不会自己走这一步，
   * 于是会话的 cwd 明明是对的，侧边栏里却留在「未分组」。
   */
  async function attachToWorkspace(sessionId, directory) {
    if (!directory) return
    let registry
    try {
      registry = (ctx.root ?? ctx).get?.('workspaceRegistry')
    } catch (error) {
      log('workspace_registry_unavailable', error)
      return
    }
    if (!registry || typeof registry.resolveByPath !== 'function') return
    try {
      const workspace = (await registry.resolveByPath(directory)) ?? (await registry.create(directory))
      await workspace.attachSession(sessionId)
    } catch (error) {
      // 分组只是侧边栏归类，失败不该让这一轮发言失败。
      log('workspace_attach_failed', { sessionId, directory, error })
    }
  }

  async function ensureAgent(bot) {
    const live = agents.get(bot.sessionId)
    if (live) return live
    const registry = requireService('agents')
    const already = registry.get?.(bot.sessionId)
    if (already) {
      agents.set(bot.sessionId, already)
      return already
    }
    const selection = modelSelection()
    const agentOptions = {}
    if (selection.provider) agentOptions.provider = selection.provider
    if (selection.model) agentOptions.model = selection.model
    if (Number.isSafeInteger(selection.maxTokens)) agentOptions.maxTokens = selection.maxTokens
    const meta = { cwd: bot.cwd || defaultCwd() }
    // 只给 cwd 不够：工具（终端、文件、检索）和系统提示都在 agent preset 里，
    // 不挂 preset 的会话能说话、但没有任何工具，就会回「没有可用的命令执行能力」。
    let setup
    const presets = rootCtx().get?.('agentPresets') ?? rootCtx().agentPresets
    if (presets && typeof presets.resolve === 'function') {
      try {
        const resolved = await presets.resolve()
        if (resolved?.id) {
          meta.agentPreset = resolved.id
          if (resolved.broken) log('preset_broken', resolved.broken)
          setup = async (agentCtx) => {
            await presets.mount(agentCtx, resolved.id)
          }
        }
      } catch (error) {
        log('preset_resolve_failed', error)
      }
    }
    let agent
    try {
      const handle = await registry.resume({ resumeSessionId: bot.sessionId, agentOptions })
      agent = handle.agent ?? handle
    } catch (error) {
      log('resume-missed', error)
      // 外部成员代表的是一个已存在的会话；找不到就不能凭空造一个同 id 的，
      // 那会变成两份记忆。让调用方看到明确的原因。
      if (bot.external === true) fail('session_unavailable', '这个成员对应的会话当前不在本机，无法发言。')
      const handle = await registry.create({ sessionId: bot.sessionId, meta, agentOptions, setup })
      agent = handle.agent ?? handle
      await attachToWorkspace(bot.sessionId, meta.cwd)
    }
    agents.set(bot.sessionId, agent)
    return agent
  }

  function defaultCwd() {
    const directory = ctx.get?.('workingDirectory') ?? ctx.workingDirectory
    try {
      if (directory?.defaultDirectory) return directory.defaultDirectory
    } catch {
      /* 取不到就退回进程目录 */
    }
    return process.cwd()
  }

  async function readReply(sessionId) {
    const persistence = requireService('sessionPersistence')
    const handle = await persistence.open(sessionId, 'read')
    try {
      const { events } = await handle.read(0, undefined, {})
      return { reply: replyOf(events ?? []), events: events ?? [] }
    } finally {
      await handle.close?.()
    }
  }

  /**
   * 这个会话里「上一次真正发进房间的那句话」是谁。
   *
   * 读回的最后一句未必属于这一轮：用户点了「停下这一轮」、或者模型这一轮只调了工具
   * 没出文本时，会话里没有新台词，`replyOf` 拿到的还是上一轮那句。不知道基线的话，
   * 那句旧台词就会被当成新话再发一遍——房间里凭空多出一条重复消息，还白占一次发言预算。
   */
  async function baselineOf(sessionId) {
    if (posted.has(sessionId)) return posted.get(sessionId)
    // 第一次接上这个会话（含进程重启后）：先把已有的最后一句记成基线。
    let id = null
    try {
      id = idOf((await readReply(sessionId)).reply)
    } catch (error) {
      // 新建的会话还没有落盘文件：本来就没有上一句。
      log('reply_baseline_missed', error)
    }
    posted.set(sessionId, id)
    return id
  }

  /**
   * 让一个 Bot 说一句话。
   * @returns {Promise<{text: string, sessionId: string}>}
   */
  async function say(bot, prompt, { signal, waitIdleFirst = false } = {}) {
    const agent = await ensureAgent(bot)
    // 外部成员背后是用户正在用的那个会话，它可能还在跑自己的回合。
    // 先等它闲下来再递话 —— 否则那句「轮到你」会被塞进正在进行的回合里，
    // 跑完读回来的其实是这一轮原本的回答，而不是对房间那句话的回应。
    if (waitIdleFirst && agent.status === 'running' && typeof agent.whenIdle === 'function') {
      await agent.whenIdle(signal)
    }
    const baseline = await baselineOf(bot.sessionId)
    const message = userMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'dsh-chatroom', botId: bot.id, sessionId: bot.sessionId },
    })
    const before = agent.session?.seq ?? 0
    if (typeof agent.followup === 'function') agent.followup(message)
    else if (typeof agent.prompt === 'function') agent.prompt(message)
    else fail('agent_drive_unsupported', '这个 DSH 版本的 Agent 没有 followup/prompt，无法驱动发言。')

    if (typeof agent.whenIdle === 'function') await agent.whenIdle(signal)
    else await waitStatus(agent, signal)

    const sessions = ctx.get?.('sessions') ?? ctx.sessions
    await sessions?.flush?.(agent.session)

    const { reply } = await readReply(bot.sessionId)
    const text = textOf(reply)
    if (!text) {
      const after = agent.session?.seq ?? 0
      fail('empty_reply', after === before ? '模型这一轮没有产生任何事件。' : '这一轮没有可用的文本回复。')
    }
    const replyId = idOf(reply)
    if (replyId !== null && replyId === baseline) {
      fail('empty_reply', '这一轮没有新的话（被中断或只做了工具调用），不把上一句再发一遍。')
    }
    posted.set(bot.sessionId, replyId)
    return { text, sessionId: bot.sessionId }
  }

  async function waitStatus(agent, signal) {
    for (let i = 0; i < 600; i += 1) {
      if (signal?.aborted) fail('cancelled')
      if (agent.status !== 'running') return
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    fail('turn_timeout')
  }

  return { say, ensureAgent, readReply }
}
