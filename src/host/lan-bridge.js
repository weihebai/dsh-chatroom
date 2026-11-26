import { hostname } from 'node:os'
import { createLanGuest } from './lan-guest.js'
import { createLanHost } from './lan-host.js'
import { project } from './project.js'

/**
 * 把这个插件在两台机器上的两种角色接到一起：
 *
 *   宿主侧：开监听、认房间码、把远程成员的回合派出去（host.enqueue）
 *   加入侧：连别人的房间、维护镜像、跑被派过来的回合（guest）
 *
 * 先有 host 再有 speaker，但 host 需要 speaker 处理「远程的人说了句话」，
 * 所以这里用 onHumanMessage 回调而不是直接传 speaker —— 一个可变引用换掉循环依赖。
 */
export function createLanBridge({ store, runner, gate = null, log = () => {}, machine = hostname(), port } = {}) {
  let speaker = null
  const host = createLanHost({
    store,
    log,
    machine,
    port,
    onHumanMessage: (args) => speaker?.afterHumanMessage(args),
  })
  const guest = createLanGuest({ store, runner, gate, log })

  function view(extra = {}) {
    // 授权档位与待授权队列只给本机的界面：它们描述的是「这台机器此刻要不要执行」，
    // 不该跟着 LAN 投影送到别的机器上。
    return Object.assign(project(store.state, { lan: host.status(), ...extra }), {
      auth: { level: gate ? gate.level() : 'readonly' },
      approvals: gate ? gate.list() : [],
    })
  }

  /** 宿主不在（没起来/端占用）时也要给出可读原因，而不是静默没有反应。 */
  function enqueue(args) {
    return host.enqueue(args)
  }

  async function start(wantPort) {
    const status = await host.start(wantPort)
    // 上次加入过的房间接回来；失败只标离线，不阻塞插件启动。
    void guest.resume()
    return status
  }

  async function dispose() {
    await guest.stop()
    await host.stop()
  }

  return {
    view,
    enqueue,
    start,
    dispose,
    status: () => host.status(),
    setSpeaker: (value) => {
      speaker = value
    },
    host,
    guest,
    join: (input) => guest.join(input),
    leave: (linkId) => guest.leave(linkId),
    send: (args) => guest.send(args),
    read: (args) => guest.read(args),
    // 往回翻历史：镜像房间更早的消息在宿主那台机器上，只能连着 LAN 要。
    page: (args) => guest.page(args),
    // 改名只报名字：颜色是每间屋里的座位，改它走下面的 setColor。
    rename: (name) => guest.rename(name),
    // 换「我在这间屋里」的虎鲸座位：宿主会拒掉被别人占着的那一档。
    setColor: (linkId, color) => guest.setColor(linkId, color),
    // 「加入之后才建 agent」这条路：本机名单变了就报给宿主，让屋里立刻有人。
    announceAgents: (onlyId) => guest.announceAgents(onlyId),
    // 某间屋的 agent 名单增删：只改这一条链接（这一间屋），不碰 agent 本体和别的房间。
    setAgentInRoom: (roomId, botId, included) => guest.setAgentInRoom(roomId, botId, included),
    linkByRoom: (roomId) => guest.linkByRoom(roomId),
  }
}
