/* dsh-chatroom client bundle —— 手写，无打包器。
 *
 * 加载协议：执行时调用 window.__ModuleLoader__.load({ id, factory })，
 * id 必须精确等于 package.json 的 name。factory 是懒 CJS 形态：
 * 只能用 module.exports，React 必须 React.createElement。
 *
 * 这一半做四件事，全部挂在 DSH 自己的 slot 契约上：
 *   1. sidebar.panellist  + main             → 侧栏「聊天室」入口与三栏主面板
 *   2. conversation.session.header.actions   → 会话标题旁的开关（悬浮窗只在会话界面用）
 *   3. shell.overlay                          → 独立悬浮窗（可拖动、可折叠、带未读）
 *   4. 未读提醒                                → 侧栏图标上的计数、页面标题前缀、新消息 toast
 *
 * 数据只有一个来源：Host 半边的 /api/dsh.chatroom/* 四个端点。
 * 所有写操作都走 command，读操作走 snapshot / watch（长轮询），
 * 于是「谁的界面都是同一间屋子」这件事由 Host 而不是浏览器负责。
 */

window.__ModuleLoader__.load({
  id: 'dsh-chatroom',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var NS = 'dsh-chatroom'
    var PANEL_ID = 'chatroom'
    var PANEL_ORDER = 30 // 与「插件」「任务监控」同列，不抢新会话的位置

    /**
     * 这一下回车是不是输入法在「选词」。
     *
     * 中文/日文输入法开着的时候，回车先是把候选词落进输入框，那一下浏览器标成
     * isComposing（老输入法只给 keyCode 229）。不认这个标记，拼音打到一半按回车
     * 就会把半截话发进屋里 —— 用户看到的是一句拼音加几个错字，还得自己撤回。
     *
     * React 的合成事件不带 isComposing，得看 nativeEvent。
     */
    function imePicking(event) {
      return Boolean(event.nativeEvent && event.nativeEvent.isComposing) || event.keyCode === 229
    }

    /* ------------------------------------------------------------------ 文案 */

    var ZH = {
      nav: '聊天室',
      title: '聊天室',
      empty: '还没有房间',
      emptyHint: '建一间屋子，把你的 agent 拉进来一起说事。',
      emptyPreview: '还没有消息',
      firstTitle: '房间在你自己的机器上',
      firstText: '建一间屋子，把你的 agent 拉进来一起说事。同一 Wi-Fi 下另一台机器用地址和六位房间码进屋，轮到它的 agent 时那台机器用自己的会话回话。',
      firstNote: '每条消息引出几个回复、agent 之间最多接力几层，都在「规则」里定 —— 一屋子 agent 才不会把 token 烧光。',
      newRoom: '新建房间',
      collapseRooms: '收起房间列表',
      expandRooms: '展开房间列表',
      resizeChat: '拖动调整聊天区宽度，双击恢复默认',
      roomName: '房间名',
      roomTopic: '这间屋子用来做什么（可留空）',
      create: '建好',
      cancel: '取消',
      send: '发送',
      sendHint: 'Enter 发送，Shift+Enter 换行；@ 点名 agent',
      speakingAs: '以',
      speakingAsEnd: '的身份发言',
      mention: '点名 agent',
      floatHint: '说点什么…',
      round: '让全员说一轮',
      stop: '停下这一轮',
      rules: '规则',
      clearHistory: '清空记录',
      clearAsk: '确定清空这间屋的聊天记录？成员和规则会保留。',
      ruleMention: '被 @ 的 agent 一定要回',
      ruleRound: '人发言后全员各说一句',
      ruleChair: '设一个主持人',
      chairNone: '不设主持人',
      maxSpeakers: '每条最多引出',
      speakersUnit: '个回复',
      maxAutoRounds: '自动讨论',
      roundsUnit: '轮后请房主拍板',
      people: '人',
      agents: 'agent',
      agentKind: 'agent',
      local: '本机',
      lan: 'LAN',
      reachHere: '在线',
      reachLocal: '本机',
      reachLan: '远程',
      remove: '移出房间',
      addAgent: '加一个 agent',
      agentName: '名字',
      agentRole: '职责（会影响它怎么说话）',
      agentCwd: '工作目录（绝对路径，agent 在这里干活；留空用默认目录）',
      agentEdit: '改这个 agent',
      whale: '虎鲸',
      whaleAuto: '自动分配',
      whaleColors: '霜白,银灰,天蓝,青绿,苔绿,琥珀,珊瑚,藕紫',
      whaleCreate: '选一档虎鲸颜色再建屋',
      whaleJoin: '选一档虎鲸颜色再进屋',
      edit: '改',
      agentNew: '新建一个 agent',
      save: '保存',
      dissolve: '解散房间',
      dissolveAsk: '解散后这间屋子和里面的记录都会没了',
      dissolveYes: '确定解散',
      code: '房间码',
      members: '成员',
      noMessages: '屋里还很安静。说第一句吧。',
      hintNotAddressed: '这句没叫到 agent —— 开头写 @名字，或者让全员说一轮。',
      hintNotAddressedRemote: '这句没叫到 agent —— 开头写 @名字，它们才会接着往下说。',
      hintCompact: '这句没叫到 agent —— 开头写 @名字。',
      hintRulesOff: '三种发言规则都关着，谁都不会自动接话。点「规则」打开一个。',
      hintCompactRulesOff: '这间屋子的发言规则都关着，谁都不会自动接话。',
      speaking: '正在发言',
      busy: '这一轮还没结束',
      floatOpen: '聊天室',
      floatClose: '收起',
      floatDrag: '拖动移动；双击回到右下角',
      floatDragPill: '拖动移动；点一下展开',
      openPanel: '打开面板',
      unread: '条未读',
      error: '出错了',
      retry: '重试',
      you: '我',
      older: '加载更早的消息',
      olderLoading: '正在载入…',
      jumpLatest: '回到最新',
      jumpFresh: '条新的',
      settingsSelf: '我的名字',
      myAgents: '我的 agent',
      myAgentsNone: '还没有 agent：建一个，加入 LAN 房间时会一起带进屋。',
      myAgentsHint: '这些是跟着你这台机器走的 agent。加到别人的屋里时，它们跑的是各自在这台机器上的会话。',
      bringAgents: '进屋会带上：',
      bringNone: '本机还没有 agent，进屋只有你一个人。',
      removeAgent: '删掉这个 agent',
      removeAgentAsk: '删掉它？',
      removeAgentYes: '删掉',
      joinLan: '加入 LAN 房间',
      joinAddress: '对方地址，如 192.168.1.5:4399',
      joinCode: '六位房间码',
      join: '加入',
      leaveLan: '离开这个房间',
      invite: '邀请',
      inviteAddress: '地址',
      inviteHint: '对方打开聊天室 → 加入 LAN 房间 → 填这个地址和房间码。两边都要开着这台机器。',
      inviteMore: '其他地址：',
      virtualNic: '虚拟网卡',
      inviteVirtualOnly:
        '这台机器只有虚拟网卡的地址，隔壁那台连不上：先连上 WiFi 或网线，再邀请。',
      copy: '复制',
      copied: '已复制',
      lanOff: 'LAN 没起来',
      remoteTag: '远程',
      hostedBy: '由',
      hosted: '同步中',
      remoteRules: '规则与成员由对端管理：在这台机器上只能发言。',
      roomGone: '这间屋子已经在宿主那台机器上解散了。',
      goneTag: '已解散',
      removeRoom: '从列表移除',
      lanPeers: '台机器在线',
      /* 只列需要处理的机器：旧版本报不了名单、或那台还没建 agent。 */
      peerNoneYet: '还没建 agent —— 在那台的左栏「我的 agent」里建一个，建完自动进来。',
      peerOld: '旧版本，报不了 agent 名单 —— 重启那台的桌面端，再进屋一次。',
      hostOldHint: '宿主的插件是旧版本，本机的 agent 名单报不过去。重启宿主那台的桌面端后重新进屋。',
      /* 本机授权：别的机器派过来的回合要不要在这台机器上执行。 */
      authTitle: '本机授权',
      authScope: '只影响这台机器',
      authReadonly: '只读',
      authAsk: '授权后执行',
      authFull: '完全授权',
      authNoteReadonly: '别的机器派来的回合不执行，屋里只说一句为什么。',
      authNoteAsk: '别的机器派来的回合先问你一次，点了允许才跑。',
      authNoteFull: '别的机器派来的回合直接执行，不再问。',
      awaitAuth: '等待本机授权',
      approveTitle: '远程执行请求',
      approveRun: '要在本机跑一个回合',
      approveFrom: '来自',
      approveRoom: '房间',
      approveAllow: '允许一次',
      approveDeny: '拒绝',
      approveHint: '只影响这一次。到点不选，按拒绝处理。',
      approveFull: '完整请求',
      approveMore: '条等待中',
      personKind: '人',
    }

    var EN = {
      nav: 'Rooms',
      title: 'Rooms',
      empty: 'No rooms yet',
      emptyPreview: 'No messages yet',
      emptyHint: 'Make a room and bring your agents in.',
      firstTitle: 'Rooms live on your machine',
      firstText: 'Make a room and bring your agents in. Another machine on the same Wi-Fi joins with an address and a six-character code, and its agents answer from their own sessions.',
      firstNote: 'How many replies one message may pull, and how deep agents may hand off, are set under Rules.',
      newRoom: 'New room',
      collapseRooms: 'Collapse room list',
      expandRooms: 'Expand room list',
      resizeChat: 'Drag to resize the chat area; double-click to reset',
      roomName: 'Room name',
      roomTopic: 'What this room is for (optional)',
      create: 'Create',
      cancel: 'Cancel',
      send: 'Send',
      sendHint: 'Enter to send, Shift+Enter for a new line; @ to call an agent',
      speakingAs: 'Speaking as',
      speakingAsEnd: '',
      mention: 'Mention an agent',
      floatHint: 'Say something…',
      round: 'Let everyone speak once',
      stop: 'Stop this round',
      rules: 'Rules',
      clearHistory: 'Clear',
      clearAsk: 'Clear this room\'s chat history? Members and rules are kept.',
      ruleMention: 'Mentioned agents always answer',
      ruleRound: 'Everyone speaks after I post',
      ruleChair: 'Have a chair',
      chairNone: 'No chair',
      maxSpeakers: 'At most',
      speakersUnit: 'replies',
      maxAutoRounds: 'Escalate after',
      roundsUnit: 'auto rounds',
      people: 'People',
      agents: 'Agents',
      agentKind: 'agent',
      local: 'Local',
      lan: 'LAN',
      reachHere: 'here',
      reachLocal: 'local',
      reachLan: 'remote',
      remove: 'Remove from room',
      addAgent: 'Add an agent',
      agentName: 'Name',
      agentRole: 'Role (shapes how it talks)',
      agentCwd: 'Working directory (absolute path; leave empty for default)',
      agentEdit: 'Edit this agent',
      whale: 'Orca',
      whaleAuto: 'auto',
      whaleColors: 'Frost,Steel,Sky,Teal,Moss,Amber,Coral,Violet',
      whaleCreate: 'Pick an orca color to create the room',
      whaleJoin: 'Pick an orca color to join',
      edit: 'Edit',
      agentNew: 'Create an agent',
      save: 'Save',
      dissolve: 'Dissolve room',
      dissolveAsk: 'Dissolving deletes this room and everything said in it',
      dissolveYes: 'Dissolve anyway',
      code: 'Room code',
      members: 'Members',
      noMessages: 'Quiet in here. Say the first thing.',
      hintNotAddressed: 'No agent was called — start with @name, or run a full round.',
      hintNotAddressedRemote: 'No agent was called — start with @name and they pick it up.',
      hintCompact: 'No agent was called — start with @name.',
      hintRulesOff: 'All three speaking rules are off, so nobody answers on their own. Open Rules and turn one on.',
      hintCompactRulesOff: 'Every speaking rule is off in this room, so nobody answers on its own.',
      speaking: 'Speaking',
      busy: 'A round is still running',
      floatOpen: 'Rooms',
      floatClose: 'Hide',
      floatDrag: 'Drag to move; double-click to send it back to the corner',
      floatDragPill: 'Drag to move; click to open',
      openPanel: 'Open panel',
      unread: 'unread',
      error: 'Failed',
      retry: 'Retry',
      you: 'me',
      older: 'Load earlier messages',
      olderLoading: 'Loading…',
      jumpLatest: 'Jump to latest',
      jumpFresh: 'new',
      settingsSelf: 'My name',
      myAgents: 'My agents',
      myAgentsNone: 'No agent yet — make one and it travels with you into a LAN room.',
      myAgentsHint: 'These agents belong to this machine: they run in their own local sessions, wherever the room is hosted.',
      bringAgents: 'Coming with you: ',
      bringNone: 'No agent on this machine yet — you would join alone.',
      removeAgent: 'Delete this agent',
      removeAgentAsk: 'Delete it?',
      removeAgentYes: 'Delete',
      joinLan: 'Join a LAN room',
      joinAddress: 'Host address, e.g. 192.168.1.5:4399',
      joinCode: 'Six-character room code',
      join: 'Join',
      leaveLan: 'Leave this room',
      invite: 'Invite',
      inviteAddress: 'Address',
      inviteHint: 'On the other machine: Rooms → Join a LAN room, then paste this address and code. Both machines stay open.',
      inviteMore: 'Other addresses: ',
      virtualNic: 'virtual adapter',
      inviteVirtualOnly:
        'This machine only has virtual-adapter addresses, so the other machine cannot reach it. Connect Wi-Fi or Ethernet first.',
      copy: 'Copy',
      copied: 'Copied',
      lanOff: 'LAN listener is off',
      remoteTag: 'Remote',
      hostedBy: 'hosted by',
      hosted: 'syncing',
      remoteRules: 'Rules and members live on the host; here you can only talk.',
      roomGone: 'The host dissolved this room.',
      goneTag: 'Dissolved',
      removeRoom: 'Remove from list',
      lanPeers: 'machines online',
      peerNoneYet: 'no agent yet — create one in that machine’s “My agents” and it joins by itself.',
      peerOld: 'old build, cannot report its agents — restart that desktop app and rejoin.',
      hostOldHint: 'The host runs an older build, so your agents cannot be reported. Restart that desktop app, then rejoin.',
      authTitle: 'Local authorization',
      authScope: 'This machine only',
      authReadonly: 'Read-only',
      authAsk: 'Ask first',
      authFull: 'Always allow',
      authNoteReadonly: 'Turns sent from another machine are not run; the room gets one short note.',
      authNoteAsk: 'Turns sent from another machine wait for your click here.',
      authNoteFull: 'Turns sent from another machine run without asking.',
      awaitAuth: 'Waiting for local authorization',
      approveTitle: 'Remote run request',
      approveRun: 'wants to run a turn on this machine',
      approveFrom: 'From',
      approveRoom: 'Room',
      approveAllow: 'Allow once',
      approveDeny: 'Deny',
      approveHint: 'This once only. If nobody answers, it is denied.',
      approveFull: 'Full request',
      approveMore: 'waiting',
      personKind: 'person',
    }

    /* -------------------------------------------------------------------- CSS */

    /* 只用宿主 token，取不到就退回中性值 —— 明暗主题都不需要单独写一套。
     * 间距按 4/8 栅格走，字号只出现 11/12/13/14 四档。 */
    var CSS = [
      /* 只用宿主 token，取不到就退回中性值 —— 明暗主题都不需要单独写一套。
       * v2：参照 Pachat 的信息编排重做（暗色宿主版）。要抄的是结构，不是它的薄荷配色：
       *   头像 + 身份/来源徽标 → 一眼分清「谁是人、谁是 agent、谁在别的机器上」
       *   气泡与引用           → 自己右对齐带底色，别人左对齐带头像；连续同一人合并
       *   宽松的行距与留白       → 正文 15px / 行高 1.65，元信息 11–12px，层次才拉得开
       *   通讯录式列表          → 房间名 + 最近时间 + 预览一行，不靠重复信息撑高度
       * 间距只走 4/8/12/16/24/32，字号只出现 11/12/13/15/18 五档，圆角只用 8/12/999。
       * 浮层底色用 bg-layer-2 而不是 bg-overlay：默认深色主题里 bg-overlay 是 #61666b（说明图/遮罩用的灰），
       * 套到浮窗上就是一块比宿主面板亮一截的灰板；bg-layer-2 才是宿主自己抬起来的那层（#2c2c2e）。
       * 主按钮的文字色用 bg-base 反色，不能写死 #fff：默认主题的 brand-primary 是近白 #f9fafb，
       * 白底白字 = 按钮上的字整个消失（真外壳里实测过）。 */
      '.cr-main,.cr-float,.cr-toast-wrap,.cr-approve{--cr-fg:var(--dsw-alias-label-primary,#e9eaee);--cr-muted:var(--dsw-alias-label-secondary,#9aa0aa);--cr-caption:var(--dsw-alias-label-caption,#81858c);--cr-line:var(--dsw-alias-border-l1,rgba(255,255,255,.09));--cr-line-strong:color-mix(in srgb,var(--cr-fg) 16%,transparent);--cr-surface:var(--dsw-alias-bg-layer-2,#2c2c2e);--cr-surface-2:color-mix(in srgb,var(--cr-fg) 6%,transparent);--cr-surface-3:color-mix(in srgb,var(--cr-fg) 10%,transparent);--cr-accent:var(--dsw-alias-brand-primary,#4f7cff);--cr-accent-soft:color-mix(in srgb,var(--cr-accent) 14%,transparent);--cr-on-accent:var(--dsw-alias-bg-base,#0b0b0c);--cr-hover:color-mix(in srgb,currentColor 7%,transparent);--cr-raised:color-mix(in srgb,currentColor 5%,transparent);--cr-danger:#e5484d;--cr-warn:#c08a2e;--cr-r:8px;--cr-r-lg:12px;--cr-r-xl:16px;--cr-s1:4px;--cr-s2:8px;--cr-s3:12px;--cr-s4:16px;--cr-s5:24px;--cr-s6:32px;--cr-shadow-1:0 1px 2px rgba(0,0,0,.28);--cr-shadow-2:0 18px 44px -14px rgba(0,0,0,.62)}',

      /* 骨架：三列只靠一条发丝线分开，不再给每一列套一层框。 */
      '.cr-main{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;color:var(--cr-fg)}',
      '.cr-grid{display:grid;grid-template-columns:248px minmax(0,1fr) 264px;height:100%;min-height:0}',
      /* 一间屋子都还没有时，成员列整列都不存在 —— 别留一根空着的第三列撑在那。 */
      '.cr-grid-first{grid-template-columns:248px minmax(0,1fr)}',
      '.cr-col{display:flex;flex-direction:column;min-height:0;min-width:0}',
      '.cr-col+.cr-col{border-left:1px solid var(--cr-line)}',
      '.cr-col-head{display:flex;align-items:center;gap:var(--cr-s2);padding:var(--cr-s4) var(--cr-s3) var(--cr-s2);min-height:48px}',
      '.cr-col-title{font-size:13px;font-weight:600;letter-spacing:.01em}',
      '.cr-count{font-size:12px;color:var(--cr-muted);font-variant-numeric:tabular-nums}',
      '.cr-grow{flex:1;min-width:0}',

      /* 按钮：一个高度、一个圆角，主次只靠填充和颜色区分。 */
      '.cr-btn{display:inline-flex;align-items:center;gap:var(--cr-s1);height:28px;padding:0 var(--cr-s2);border:1px solid var(--cr-line);border-radius:var(--cr-r);background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer}',
      '.cr-btn:hover{background:var(--cr-hover)}',
      '.cr-btn:disabled{opacity:.45;cursor:default}',
      '.cr-btn:disabled:hover{background:transparent}',
      '.cr-btn.cr-primary{border-color:transparent;background:var(--cr-accent);color:var(--cr-on-accent)}',
      '.cr-btn.cr-primary:hover{filter:brightness(1.06)}',
      '.cr-btn.cr-ghost{border-color:transparent;color:var(--cr-muted);height:24px}',
      '.cr-btn.cr-ghost:hover{background:var(--cr-hover);color:var(--cr-fg)}',
      '.cr-btn.cr-danger{color:var(--cr-danger);border-color:color-mix(in srgb,var(--cr-danger) 38%,transparent)}',
      '.cr-btn.cr-danger:hover{background:color-mix(in srgb,var(--cr-danger) 12%,transparent)}',
      '.cr-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:var(--cr-r);background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1;opacity:.55;cursor:pointer}',
      '.cr-icon-btn:hover{opacity:1;background:var(--cr-hover)}',

      /* 房间列表：头像 + 名字/时间 + 预览，两行就是全部信息，不再重复房间名。 */
      '.cr-rooms{overflow:auto;padding:0 var(--cr-s2) var(--cr-s4);display:flex;flex-direction:column;gap:2px}',
      '.cr-room{display:flex;gap:var(--cr-s3);align-items:flex-start;padding:var(--cr-s2) var(--cr-s2);border-radius:var(--cr-r-lg);cursor:pointer;position:relative;overflow:hidden}',
      '.cr-room:hover{background:var(--cr-hover)}',
      '.cr-room.cr-active{background:var(--cr-surface-2)}',
      '.cr-room.cr-active::before{content:"";position:absolute;left:0;top:var(--cr-s2);bottom:var(--cr-s2);width:2px;border-radius:999px;background:var(--cr-accent)}',
      '.cr-room-avatar{flex:0 0 auto;width:32px;height:32px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;background:var(--cr-surface-3);color:var(--cr-fg);border:1px solid var(--cr-line)}',
      '.cr-room-body{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;overflow:hidden}',
      '.cr-room-top{display:flex;align-items:center;gap:var(--cr-s2);min-width:0;overflow:hidden}',
      '.cr-room-name{font-size:13px;font-weight:500;flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-room-time{flex:0 0 auto;font-size:12px;color:var(--cr-muted);font-variant-numeric:tabular-nums}',
      '.cr-room-preview{font-size:12px;line-height:1.5;color:var(--cr-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 未读数字要在徽标底色上看得见：默认主题里 brand-primary 本身就是近白
      // （#f9fafb），配 #fff 等于白字白底、对比度 1.04:1 —— 实机上就是一坨白点。
      // 底色用 accent，字色反色（--cr-on-accent），并给作用域外的位置留兜底。
      '.cr-badge{min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--cr-accent,var(--dsw-alias-brand-primary,#4f7cff));color:var(--cr-on-accent,var(--dsw-alias-bg-base,#0b0b0c));font-size:11px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}',
      '.cr-form{display:flex;flex-direction:column;gap:var(--cr-s2);padding:var(--cr-s2) var(--cr-s3) var(--cr-s4)}',
      '.cr-field{width:100%;box-sizing:border-box;height:32px;padding:0 var(--cr-s3);border:1px solid var(--cr-line);border-radius:var(--cr-r);background:transparent;color:inherit;font:inherit;font-size:13px}',
      '.cr-field::placeholder{color:var(--cr-caption)}',
      '.cr-field:focus{outline:1px solid var(--cr-accent);outline-offset:-1px;border-color:transparent}',
      /* 我的名字：坐在键盘前的这个人叫什么，决定对面看到的名字。 */
      '.cr-name-row{display:flex;align-items:center;gap:var(--cr-s2);min-height:24px}',
      '.cr-name-label{font-size:12px;color:var(--cr-muted);flex:0 0 auto}',
      '.cr-name-row .cr-field{flex:1;min-width:0}',
      '.cr-hint{font-size:12px;color:var(--cr-muted);line-height:1.5}',
      '.cr-chips{display:flex;flex-wrap:wrap;gap:var(--cr-s2)}',
      '.cr-agent-chip{display:inline-flex;align-items:center;max-width:180px;height:24px;line-height:24px;padding:0 var(--cr-s2);border-radius:999px;font-size:12px}',
      '.cr-agent-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.cr-agent-x{border:0;background:transparent;color:var(--cr-muted);font:inherit;font-size:12px;line-height:1;padding:0;cursor:pointer;min-width:24px;min-height:24px;display:inline-flex;align-items:center;justify-content:center;margin-right:-4px}',
      '.cr-agent-x:hover{color:var(--cr-danger)}',
      '.cr-agent-ask{max-width:none}',
      '.cr-agent-yes{border:0;background:transparent;color:var(--cr-danger);font:inherit;font-size:11px;line-height:1;padding:0 var(--cr-s1);cursor:pointer;min-height:20px;text-decoration:underline;text-underline-offset:2px}',
      '.cr-my-form{display:flex;flex-direction:column;gap:var(--cr-s2);padding-top:var(--cr-s1)}',
      /* agent 的名字与职责：建的时候填，之后还能改（职责决定它怎么说话）。 */
      '.cr-agent-form{display:flex;flex-direction:column;gap:var(--cr-s2);padding:var(--cr-s3);border-radius:var(--cr-r-lg);background:var(--cr-surface-2)}',
      '.cr-agent-form .cr-field{background:var(--cr-surface)}',
      '.cr-member.cr-member-editing{display:block;padding:0;background:none}',
      '.cr-member.cr-member-editing:hover{background:none}',

      /* 消息列：头部两层（房间名 / 主题），滚动区只留消息。 */
      '.cr-room-head{display:flex;flex-direction:column;gap:2px;padding:var(--cr-s3) var(--cr-s5) var(--cr-s3);border-bottom:1px solid var(--cr-line)}',
      '.cr-room-head-top{display:flex;align-items:center;gap:var(--cr-s2);min-width:0;overflow:hidden}',
      '.cr-room-head-sub{font-size:12px;line-height:1.5;color:var(--cr-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-room-title{font-size:18px;font-weight:600;letter-spacing:-.01em;flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-chip{flex:0 0 auto;display:inline-flex;align-items:center;height:20px;line-height:20px;padding:0 var(--cr-s2);border-radius:999px;background:var(--cr-surface-2);color:var(--cr-muted);font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums;max-width:160px;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}',
      '.cr-chip.cr-lan{color:var(--cr-accent);background:var(--cr-accent-soft)}',
      '.cr-chip.cr-danger{color:var(--cr-danger);background:color-mix(in srgb,var(--cr-danger) 14%,transparent)}',
      '.cr-flow{flex:1;min-height:0;overflow:auto;padding:var(--cr-s5) var(--cr-s5) var(--cr-s4);display:flex;flex-direction:column;gap:var(--cr-s4)}',
      /* 往回翻历史之后，人停在上头；没有这一步就得靠滚轮一路滚到底才能回到最新那句。
         sticky 贴在滚动容器底部，不占内容高度、也不跟消息抢位置。 */
      '.cr-jump{position:sticky;bottom:var(--cr-s2);align-self:center;height:28px;padding:0 var(--cr-s4);border:1px solid var(--cr-line);border-radius:999px;background:var(--cr-surface);color:var(--cr-fg);font:inherit;font-size:12px;line-height:1;cursor:pointer;box-shadow:var(--cr-shadow-2)}',
      '.cr-jump:hover{background:var(--cr-hover)}',
      /* 一天的分隔：两条发丝线中间一行日期，滚动时才分得清哪句是今天。 */
      '.cr-day{display:flex;align-items:center;gap:var(--cr-s3);color:var(--cr-muted);font-size:12px}',
      '.cr-day::before,.cr-day::after{content:"";height:1px;flex:1;background:var(--cr-line)}',

      /* 消息行：别人左对齐带头像无底色，自己右对齐带底色；连续同一人收起头像与署名。 */
      '.cr-msg{display:flex;gap:var(--cr-s3);align-items:flex-start}',
      '.cr-msg.cr-cont{margin-top:calc(-1 * var(--cr-s3))}',
      '.cr-msg.cr-cont .cr-avatar{visibility:hidden;height:0}',
      '.cr-msg.cr-cont .cr-msg-meta{display:none}',
      '.cr-avatar{width:28px;height:28px;border-radius:999px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;background:var(--cr-surface-2);border:1px solid var(--cr-line);color:inherit}',
      '.cr-msg-body{min-width:0;flex:1;display:flex;flex-direction:column;align-items:flex-start;gap:var(--cr-s1)}',
      '.cr-msg-meta{display:flex;align-items:center;gap:var(--cr-s2);flex-wrap:wrap;min-width:0}',
      '.cr-msg-name{font-size:13px;font-weight:600}',
      /* 消息署名行里的来源：同一条从别的机器来的消息会连着出现很多次，
       * 常驻胶囊会把整列读成「一排标签」。这里退成同色系的小字，只在成员列用胶囊。 */
      '.cr-msg-meta .cr-chip{background:transparent;padding:0;height:auto;line-height:1.4}',
      '.cr-msg-meta .cr-chip.cr-lan{background:transparent}',
      '.cr-msg-meta .cr-chip.cr-danger{background:transparent}',
      '.cr-msg-time{font-size:12px;color:var(--cr-muted);font-variant-numeric:tabular-nums}',
      '.cr-msg-text{font-size:15px;line-height:1.65;white-space:pre-wrap;word-break:break-word;max-width:min(680px,100%)}',
      '.cr-msg-text code{font-size:13px;padding:1px var(--cr-s1);border-radius:var(--cr-r);background:var(--cr-surface-3)}',
      '.cr-msg-text strong{font-weight:600}',
      '.cr-mention{color:var(--cr-accent);font-weight:500}',
      '.cr-msg.cr-mine{flex-direction:row-reverse}',
      '.cr-msg.cr-mine .cr-msg-body{align-items:flex-end}',
      '.cr-msg.cr-mine .cr-msg-meta{justify-content:flex-end}',
      '.cr-msg.cr-mine .cr-msg-text{background:var(--cr-accent-soft);border:1px solid color-mix(in srgb,var(--cr-accent) 18%,transparent);border-radius:var(--cr-r-lg) var(--cr-r-lg) var(--cr-s1) var(--cr-r-lg);padding:var(--cr-s2) var(--cr-s3)}',
      '.cr-msg.cr-mine .cr-avatar{background:var(--cr-accent-soft);color:var(--cr-accent);border-color:transparent}',
      '.cr-msg.cr-error .cr-msg-text{color:var(--cr-muted)}',
      /* agent 没回上来那一行要能重来：按钮跟在这条消息下面，不挤进署名行。 */
      '.cr-msg-actions{display:flex;align-items:center;gap:var(--cr-s3);margin-top:var(--cr-s1)}',
      '.cr-msg.cr-mine .cr-msg-actions{justify-content:flex-end}',
      '.cr-msg-actions .cr-link-btn{color:var(--cr-accent)}',
      '.cr-msg-actions .cr-link-btn:hover{color:var(--cr-fg)}',
      '.cr-msg-actions .cr-link-btn:disabled{color:var(--cr-muted);cursor:default}',
      '.cr-thinking{display:flex;align-items:center;gap:var(--cr-s1);font-size:12px;color:var(--cr-muted);padding-left:40px}',
      /* 「说了一句、谁都没接」时的一句解释。它不是消息，所以不占消息行、不比正文大：
       * 左边一条发丝线，和消息正文对齐（40px = 头像 28 + 间距 12），跟着最后一条往下走。 */
      '.cr-hint{margin:0 0 0 40px;padding:0 0 0 var(--cr-s3);border-left:2px solid var(--cr-line);color:var(--cr-muted);font-size:13px;line-height:1.6}',
      /* 左栏是 248px 的窄列：那条缩进 + 竖线是给消息流里的解释用的，
       * 挪到窄列里会把字挤成两三行还错位 —— 这里只保留一行说明。 */
      '.cr-hint.cr-flat{margin:0;padding:0;border-left:0;font-size:12px;line-height:1.6}',
      /* 往回翻历史：投影只有最近 200 条，更早的要一句一句点回来。
       * 做成顶部一枚窄胶囊、居中 —— 它是「列表的起点」，不该长得像一条消息。 */
      '.cr-older{display:flex;justify-content:center;padding:0 0 var(--cr-s2)}',
      '.cr-older-btn{height:28px;padding:0 var(--cr-s4);border:1px solid var(--cr-line);border-radius:999px;background:transparent;color:var(--cr-muted);font:inherit;font-size:12px;line-height:1;cursor:pointer}',
      '.cr-older-btn:hover{background:var(--cr-hover);color:var(--cr-fg)}',
      '.cr-older-btn:disabled{cursor:default;opacity:.6}',
      '.cr-older-btn:disabled:hover{background:transparent;color:var(--cr-muted)}',
      '.cr-dot{width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.5;animation:cr-pulse 1.4s ease-in-out infinite}',
      '.cr-dot:nth-child(2){animation-delay:.2s}.cr-dot:nth-child(3){animation-delay:.4s}',
      '@keyframes cr-pulse{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:.9;transform:translateY(-1px)}}',

      /* 输入区：一封「信」的形状 —— 身份行在上面，输入壳体里是正文 + @，发送是圆形主键。 */
      '.cr-composer{border-top:1px solid var(--cr-line);padding:var(--cr-s2) var(--cr-s5) var(--cr-s4);display:flex;flex-direction:column;gap:var(--cr-s2)}',
      '.cr-composer-identity{font-size:12px;line-height:1.5;color:var(--cr-muted)}',
      '.cr-composer-identity b{font-size:13px;font-weight:500;color:var(--cr-fg)}',
      '.cr-input-row{display:flex;gap:var(--cr-s2);align-items:flex-end}',
      '.cr-input-shell{flex:1;min-width:0;display:flex;align-items:flex-end;gap:var(--cr-s2);padding:var(--cr-s2) var(--cr-s2) var(--cr-s2) var(--cr-s3);border:1px solid var(--cr-line);border-radius:var(--cr-r-lg);background:var(--cr-surface-2)}',
      '.cr-input-shell:focus-within{border-color:color-mix(in srgb,var(--cr-accent) 45%,var(--cr-line))}',
      '.cr-textarea{flex:1;min-height:24px;max-height:200px;resize:none;border:0;border-radius:0;background:transparent;color:inherit;font:inherit;font-size:15px;line-height:1.6;padding:0;box-sizing:border-box}',
      '.cr-textarea::placeholder{color:var(--cr-caption)}',
      '.cr-textarea:focus{outline:0}',
      '.cr-mention-btn{flex:0 0 auto;width:24px;height:24px;padding:0;border:0;border-radius:999px;justify-content:center;border-color:transparent;color:var(--cr-muted);opacity:.8}',
      '.cr-mention-btn:hover{background:var(--cr-hover);color:var(--cr-fg);opacity:1}',
      '.cr-send{flex:0 0 auto;height:32px;min-width:32px;padding:0 var(--cr-s3);border-radius:999px;background:var(--cr-accent);color:var(--cr-on-accent);font-size:13px;white-space:nowrap}',
      '.cr-send:hover{filter:brightness(1.06)}',
      '.cr-send:disabled{opacity:.4;cursor:default;filter:none}',
      '.cr-composer-foot{display:flex;align-items:center;gap:var(--cr-s2);font-size:11px;color:var(--cr-caption);min-height:24px}',
      '.cr-mention-pop{position:absolute;bottom:calc(100% - 4px);left:var(--cr-s5);z-index:5;min-width:200px;max-height:240px;overflow:auto;padding:var(--cr-s1);border:1px solid var(--cr-line);border-radius:var(--cr-r-lg);background:var(--cr-surface);box-shadow:var(--cr-shadow-2);display:flex;flex-direction:column;gap:2px}',
      '.cr-pop-row{display:flex;align-items:center;gap:var(--cr-s2);padding:var(--cr-s1) var(--cr-s2);border:0;border-radius:var(--cr-r);background:transparent;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer}',
      '.cr-pop-row:hover{background:var(--cr-hover)}',
      '.cr-pop-row.cr-active{background:var(--cr-hover)}',
      /* 浮窗里的输入区复用面板那一套（含 @ 候选），只压一档尺寸：
       * 这是 360 宽的角落，不是整块中栏。 */
      '.cr-composer-compact{padding:var(--cr-s2) var(--cr-s3) var(--cr-s3);gap:var(--cr-s1);background:var(--cr-surface)}',
      '.cr-composer-compact .cr-composer-identity{font-size:11px}',
      '.cr-composer-compact .cr-input-shell{padding:var(--cr-s1) var(--cr-s1) var(--cr-s1) var(--cr-s3);gap:var(--cr-s1)}',
      '.cr-composer-compact .cr-textarea{font-size:13px;line-height:1.5;min-height:22px;max-height:96px}',
      '.cr-composer-compact .cr-send{height:30px;min-width:30px;padding:0 var(--cr-s3);font-size:12px}',
      '.cr-composer-compact .cr-mention-pop{left:var(--cr-s3);right:var(--cr-s3);min-width:0}',

      /* 成员列：头像 + 名字（第二行职责或机器名）+ 来源徽标。 */
      '.cr-members{overflow:auto;padding:0 var(--cr-s2) var(--cr-s4);display:flex;flex-direction:column;gap:2px}',
      '.cr-group-label{font-size:12px;font-weight:500;color:var(--cr-muted);padding:var(--cr-s3) var(--cr-s2) var(--cr-s1);margin-top:var(--cr-s2);border-top:1px solid var(--cr-line)}',
      '.cr-group-label:first-child{margin-top:0;padding-top:var(--cr-s2);border-top:0}',
      '.cr-member{display:flex;align-items:center;gap:var(--cr-s3);padding:var(--cr-s2);border-radius:var(--cr-r-lg)}',
      '.cr-member:hover{background:var(--cr-hover)}',
      '.cr-member-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-member-role{font-size:11px;color:var(--cr-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-member .cr-icon-btn{opacity:0}',
      '.cr-member:hover .cr-icon-btn{opacity:.7}',
      /* 「改」只在鼠标落到这一行时才出现：常驻会白占宽度，把职责那一行提前截断。 */
      '.cr-member .cr-icon-btn.cr-edit-btn{display:none}',
      '.cr-member:hover .cr-icon-btn.cr-edit-btn{display:inline-flex}',
      '.cr-rules{border-top:1px solid var(--cr-line);padding:var(--cr-s3) var(--cr-s4);display:flex;flex-direction:column;gap:var(--cr-s3);font-size:13px}',
      '.cr-check{display:flex;gap:var(--cr-s2);align-items:center;line-height:1.5;cursor:pointer}',
      '.cr-check input{accent-color:var(--cr-accent)}',
      '.cr-confirm{display:flex;flex-direction:column;gap:var(--cr-s2);margin-top:var(--cr-s1);padding-top:var(--cr-s3);border-top:1px solid var(--cr-line)}',
      '.cr-confirm-text{font-size:12px;line-height:1.6;color:var(--cr-danger)}',
      '.cr-confirm-row{display:flex;gap:var(--cr-s2)}',
      '.cr-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--cr-s2);height:100%;padding:var(--cr-s5);text-align:center;color:var(--cr-muted);font-size:13px;line-height:1.7}',
      /* 首屏（一间屋子都还没有）：中栏本来是空的，只留一句提示会像渲染挂了。
       * 这里给一块真正的第一屏：一句话说清房间在哪、另一台机器怎么进来，两个入口直接可用。 */
      '.cr-first{flex:1;justify-content:center;align-items:flex-start;gap:var(--cr-s3);padding:var(--cr-s6);box-sizing:border-box}',
      '.cr-first-inner{width:100%;max-width:440px;margin:0 auto;display:flex;flex-direction:column;gap:var(--cr-s4)}',
      '.cr-first-title{font-size:18px;font-weight:600;line-height:1.4;color:var(--cr-fg);letter-spacing:-.01em}',
      '.cr-first-text{margin:0;font-size:15px;line-height:1.7;color:var(--cr-muted)}',
      '.cr-first-actions{display:flex;gap:var(--cr-s2);flex-wrap:wrap}',
      '.cr-first-note{margin:0;font-size:12px;line-height:1.6;color:var(--cr-caption)}',

      /* LAN：加入别人的屋子 / 邀请另一台机器。整条通栏铺开，不再浮在消息区里当一张小卡片。 */
      '.cr-col-foot{margin-top:auto;padding:var(--cr-s3) var(--cr-s3) var(--cr-s4);border-top:1px solid var(--cr-line);display:flex;flex-direction:column;gap:var(--cr-s2)}',
      '.cr-link-btn{border:0;background:transparent;color:var(--cr-muted);font:inherit;font-size:12px;padding:0;min-height:24px;cursor:pointer;text-align:left;line-height:1.5}',
      '.cr-link-btn:hover{color:var(--cr-fg)}',
      '.cr-invite{display:flex;flex-direction:column;gap:var(--cr-s2);padding:var(--cr-s3) var(--cr-s5) var(--cr-s4);border-bottom:1px solid var(--cr-line);background:var(--cr-surface-2)}',
      '.cr-invite-row{display:flex;align-items:center;gap:var(--cr-s2);font-size:13px;min-height:28px}',
      '.cr-invite-label{color:var(--cr-muted);font-size:12px;width:52px;flex:0 0 52px;white-space:nowrap}',
      '.cr-invite code{font-size:13px;padding:2px var(--cr-s2);border-radius:var(--cr-r);background:var(--cr-surface-3);font-variant-numeric:tabular-nums}',
      '.cr-invite-note{font-size:12px;color:var(--cr-muted);line-height:1.6}',
      /* 需要处理的机器：机器名一行、原因一行。它回答的是「agent 为什么没进来」，
       * 所以「旧版本报不了」和「还没建」必须长得不一样，不能糊成一句「无」。 */
      '.cr-machines{border-top:1px solid var(--cr-line);margin-top:var(--cr-s2);padding:var(--cr-s2) var(--cr-s2) 0}',
      '.cr-peer{display:flex;flex-direction:column;min-width:0;padding:var(--cr-s1) 0;font-size:12px;line-height:1.5}',
      '.cr-peer-machine{color:var(--cr-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-peer-state{color:var(--cr-muted);word-break:break-word}',
      '.cr-warn{color:var(--cr-warn);font-size:12px;line-height:1.5;word-break:break-word}',

      /* 本机授权：三档一排，从「只读」逐级放宽到「完全授权」。
       * 它只决定这台机器要不要替别的机器跑回合，所以放在成员列底部那条通栏里，
       * 和「邀请 / 离开」同一层；不进「规则」——规则是房间的，这个是你这台机器的。 */
      '.cr-auth{display:flex;flex-direction:column;gap:var(--cr-s2);padding:var(--cr-s3) var(--cr-s4);border-top:1px solid var(--cr-line)}',
      '.cr-auth-head{display:flex;align-items:center;gap:var(--cr-s2);font-size:12px;font-weight:500;color:var(--cr-muted)}',
      '.cr-auth-head .cr-grow{flex:1}',
      '.cr-auth-scope{font-size:11px;font-weight:400;color:var(--cr-caption)}',
      '.cr-auth-seg{display:flex;gap:2px;padding:2px;border:1px solid var(--cr-line);border-radius:var(--cr-r-lg);background:var(--cr-surface-2)}',
      '.cr-auth-btn{flex:1;min-height:26px;border:0;border-radius:var(--cr-r);background:transparent;color:var(--cr-muted);font:inherit;font-size:12px;line-height:1.4;padding:0 var(--cr-s1);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.cr-auth-btn:hover{color:var(--cr-fg);background:var(--cr-hover)}',
      '.cr-auth-btn.cr-on{background:var(--cr-surface-3);color:var(--cr-fg);font-weight:500}',
      '.cr-auth-note{font-size:11px;line-height:1.5;color:var(--cr-caption)}',

      /* 授权窗口：别的机器要在这台机器上跑一个 agent 回合。
       * 它压在所有东西上面（包括浮窗），因为那是一个正等着人点的决定；
       * 也不跟着浮窗开合走 —— 浮窗收着的时候一样可能有人来敲门。 */
      '.cr-approve{position:fixed;left:50%;top:var(--cr-s4);transform:translateX(-50%);width:min(460px,calc(100vw - 32px));z-index:90;display:flex;flex-direction:column;gap:var(--cr-s3);padding:var(--cr-s4);border:1px solid var(--cr-line-strong);border-radius:var(--cr-r-lg);background:var(--cr-surface);box-shadow:var(--cr-shadow-2);color:var(--cr-fg);font-family:inherit}',
      '.cr-approve-head{display:flex;align-items:center;gap:var(--cr-s2)}',
      '.cr-approve-eyebrow{flex:1;font-size:11px;letter-spacing:.04em;color:var(--cr-caption)}',
      '.cr-approve-count{font-size:11px;color:var(--cr-caption);font-variant-numeric:tabular-nums}',
      '.cr-approve-who{font-size:14px;font-weight:600;line-height:1.5;word-break:break-word}',
      '.cr-approve-meta{font-size:12px;line-height:1.6;color:var(--cr-muted);word-break:break-word}',
      '.cr-approve-body{max-height:168px;overflow:auto;padding:var(--cr-s3);border-radius:var(--cr-r);background:var(--cr-surface-2);font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--cr-fg)}',
      '.cr-approve-quote{font-size:13px;line-height:1.6;color:var(--cr-fg);padding-left:var(--cr-s3);border-left:2px solid var(--cr-line-strong);word-break:break-word}',
      '.cr-approve-detail{display:flex;flex-direction:column;gap:var(--cr-s1)}',
      '.cr-approve-label{font-size:11px;color:var(--cr-caption)}',
      '.cr-approve-foot{display:flex;align-items:center;gap:var(--cr-s2)}',
      '.cr-approve-foot .cr-grow{flex:1}',
      '.cr-approve-hint{font-size:11px;line-height:1.5;color:var(--cr-caption);text-align:right}',
      /* 「这一轮没执行」的说明：不是谁说的话，也不是失败，所以不带头像、不进气泡。 */
      '.cr-notice{margin:var(--cr-s2) 0 var(--cr-s2) 40px;padding:var(--cr-s2) var(--cr-s3);border-left:2px solid var(--cr-line);font-size:12px;line-height:1.6;color:var(--cr-muted);word-break:break-word}',
      '.cr-float-msg.cr-notice,.cr-float-flow .cr-notice{margin:0;font-size:11px}',

      /* 悬浮窗：外层只负责定位和拖动，视觉全在胶囊和卡片上。
       * 卡片 360 宽：320 装不下「头像 + 名字 + 来源 + 时间」一行，正文也会被挤成短句。 */
      '.cr-float{position:fixed;right:var(--cr-s4);bottom:96px;z-index:70;display:flex;flex-direction:column;align-items:flex-end;gap:var(--cr-s2);pointer-events:none;font-family:inherit;color:var(--cr-fg)}',
      /* 收起态不是一颗只写房间名的胶囊：没点开之前它是唯一入口，
       * 所以要带上最后一句和未读数 —— 否则人得先展开才知道屋里刚说了什么。 */
      '.cr-float-pill{pointer-events:auto;display:flex;align-items:center;gap:var(--cr-s2);height:44px;max-width:300px;padding:0 var(--cr-s3) 0 var(--cr-s2);border:1px solid var(--cr-line);border-radius:var(--cr-r-lg);background:var(--cr-surface);box-shadow:var(--cr-shadow-2);color:var(--cr-fg);font:inherit;text-align:left;cursor:grab;user-select:none;touch-action:none}',
      '.cr-float-pill:hover{border-color:var(--cr-line-strong)}',
      '.cr-float-pill-id{display:flex;flex-direction:column;align-items:flex-start;gap:1px;min-width:0;flex:1}',
      '.cr-float-pill-name{font-size:12px;font-weight:600;line-height:1.35;max-width:196px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-float-pill-say{font-size:11px;line-height:1.35;color:var(--cr-muted);max-width:196px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-float-card{pointer-events:auto;width:360px;max-height:min(520px,70vh);display:flex;flex-direction:column;border:1px solid var(--cr-line);border-radius:var(--cr-r-xl);background:var(--cr-surface);box-shadow:var(--cr-shadow-2);color:var(--cr-fg);overflow:hidden}',
      /* 标题栏两行：房间名 + 「几个人、几台机器」。第二行不是装饰 ——
       * 浮窗里没有成员列，「这屋还有谁」只能从这一行读出来。 */
      '.cr-float-head{display:flex;align-items:center;gap:var(--cr-s2);min-height:56px;padding:var(--cr-s2) var(--cr-s2) var(--cr-s2) var(--cr-s3);border-bottom:1px solid var(--cr-line);cursor:grab;user-select:none;touch-action:none}',
      '.cr-float-mark{flex:0 0 auto;width:26px;height:26px;border-radius:var(--cr-r);display:flex;align-items:center;justify-content:center;background:var(--cr-accent-soft);color:var(--cr-fg)}',
      '.cr-float-id{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
      '.cr-float-title{font-size:14px;font-weight:600;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-float-sub{font-size:11px;line-height:1.4;color:var(--cr-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      /* 拖动是这扇窗唯一的位移方式：标题栏就是抓手（光标换成抓），拖的时候换成抓紧。 */
      '.cr-float-pill.cr-dragging,.cr-float-head.cr-dragging{cursor:grabbing}',
      /* 滚动区顶部压一条淡出：最近一句总在底部，往上一条就是从半个字开始切的 ——
       * 淡出把「切」变成「还在往上滚」。 */
      '.cr-float-flow{overflow:auto;padding:var(--cr-s4) var(--cr-s3) var(--cr-s3);display:flex;flex-direction:column;gap:var(--cr-s4);min-height:96px;-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 var(--cr-s4));mask-image:linear-gradient(to bottom,transparent 0,#000 var(--cr-s4))}',
      /* 浮窗直接复用面板那一套消息行（头像、署名、LAN 机器名、连说合组、日期线），
       * 只把字号各降一档、头像缩到 24：360 宽里正文要放得下二十来个汉字。 */
      '.cr-float-msg{flex:0 0 auto;word-break:break-word}',
      '.cr-msg.cr-float-msg{gap:var(--cr-s2)}',
      '.cr-float-msg .cr-avatar{width:24px;height:24px;font-size:11px}',
      '.cr-float-msg .cr-msg-meta{gap:var(--cr-s1)}',
      '.cr-float-msg .cr-msg-name{font-size:12px}',
      '.cr-float-msg .cr-msg-time{font-size:11px}',
      '.cr-float-msg .cr-msg-text{font-size:14px;line-height:1.6}',
      '.cr-float-msg.cr-mine .cr-msg-text{font-size:14px;line-height:1.6}',
      /* 没回上来那一条的正文装进一块底：失败不是一句普通的灰字，它是一个待处理状态。 */
      '.cr-float-msg.cr-float-failed .cr-msg-text{background:var(--cr-surface-2);border:1px solid var(--cr-line);border-radius:var(--cr-r-lg);padding:var(--cr-s2) var(--cr-s3);color:var(--cr-muted)}',
      /* 名字、来源、时间分三档：名字最亮，机器名与时间压下去 —— 不然一行里三个词一样重。
       * 宿主这档 label-secondary 已经接近正文亮度，所以这里按前景色兑透明度算一档更暗的。 */
      '.cr-float-msg .cr-msg-time,.cr-float-msg .cr-msg-meta .cr-chip,.cr-float-msg .cr-msg-meta .cr-chip.cr-lan{color:color-mix(in srgb,var(--cr-fg) 55%,transparent)}',
      /* 没回上来那一条：正文压灰，底下给一枚真的按钮 —— 「重试」是失败消息唯一的出口，
       * 写成一行小字太容易被当成脚注。 */
      '.cr-float-msg .cr-msg-actions{margin-top:var(--cr-s2)}',
      '.cr-float-msg .cr-msg-actions .cr-link-btn{height:24px;padding:0 var(--cr-s3);border:1px solid var(--cr-line);border-radius:999px;color:var(--cr-fg);font-size:12px;line-height:22px}',
      '.cr-float-msg .cr-msg-actions .cr-link-btn:hover{border-color:var(--cr-line-strong);color:var(--cr-fg);background:var(--cr-hover)}',
      '.cr-float-empty{flex:1;justify-content:center;min-height:120px;padding:var(--cr-s4);font-size:12px}',
      '.cr-float-thinking{padding-left:32px}',
      /* 「说了一句没人接」在浮窗里也要解释：左边一条发丝线，和正文对齐（头像 24 + 间距 8）。 */
      '.cr-float-hint{margin:0 0 0 32px;padding-left:var(--cr-s3);border-left:2px solid var(--cr-line);color:var(--cr-muted);font-size:12px;line-height:1.6}',

      /* 提醒 */
      '.cr-toast-wrap{position:fixed;right:var(--cr-s4);top:56px;z-index:75;display:flex;flex-direction:column;gap:var(--cr-s2);pointer-events:none}',
      '.cr-toast{pointer-events:auto;max-width:320px;display:flex;flex-direction:column;gap:var(--cr-s1);padding:var(--cr-s3);border:1px solid var(--cr-line);border-radius:var(--cr-r-lg);background:var(--cr-surface);box-shadow:var(--cr-shadow-2);font-size:13px;line-height:1.5;color:var(--cr-fg);cursor:pointer}',
      '.cr-toast-name{font-size:12px;color:var(--cr-muted)}',
      // 侧栏那颗在 token 作用域之外（宿主只把 --dsw-alias-* 挂在面板元素上），
      // 所以这里不能只写 var(--cr-accent)：取不到就是透明底，数字只剩描边。
      '.cr-nav-badge{position:absolute;top:-5px;right:-6px;min-width:16px;height:16px;padding:0 var(--cr-s1);border-radius:999px;background:var(--cr-accent,var(--dsw-alias-brand-primary,#4f7cff));color:var(--cr-on-accent,var(--dsw-alias-bg-base,#0b0b0c));font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}',
      /* 页面级错误条，别写成 .cr-error：那条类名已经被「没回上来的那条消息」占着，
       * 撞在一起会让每一条失败消息都被这条横幅的底色和缩进套上。 */
      '.cr-error-bar{color:var(--cr-danger);font-size:13px;line-height:1.5;padding:var(--cr-s2) var(--cr-s5);background:color-mix(in srgb,var(--cr-danger) 9%,transparent);border-bottom:1px solid color-mix(in srgb,var(--cr-danger) 24%,transparent)}',
      '@media (max-width:980px){.cr-grid{grid-template-columns:220px minmax(0,1fr)}.cr-col-members{display:none}.cr-float-card{width:320px}}',
      '@media (max-width:1120px){.cr-room-title{font-size:15px}.cr-flow{padding:var(--cr-s4) var(--cr-s4) var(--cr-s4)}}',
      /* ==================================================================
       * 2026-11-23 重做：版式与尺寸照 reactbits-pro 的 appui 三份源码
       *   Chat 1        —— 房间列表 / 消息行 / 输入器
       *   AI Chat 6     —— 成员与活动栏（发丝时间轴、6px 圆点）
       *   AI Chat 5     —— 本机授权卡（双层框 + Show request + 白主键）
       * 只把它的 neutral 灰阶换成宿主 token；尺寸、圆角、字号照抄。
       * ================================================================== */
      '.cr-main,.cr-float,.cr-toast-wrap,.cr-approve{--cr-r-sm:6px;--cr-r:8px;--cr-r-lg:10px;--cr-r-xl:14px;--cr-fill-1:color-mix(in srgb,var(--cr-fg) 4%,transparent);--cr-fill-2:color-mix(in srgb,var(--cr-fg) 7%,transparent);--cr-fill-3:color-mix(in srgb,var(--cr-fg) 11%,transparent);--cr-body:var(--dsw-alias-label-secondary,#cfd3d6);--cr-whale:url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABHCAYAAAD4MUK2AAACN0lEQVR42u1dy3YFIQgzHP//l9NVF13cnnYGIQjuW0cCQXldkFyz1lprfQsCkZvayP2H8MPXvkxIcNoHA0CcZqZy8BY4IByEggPfjIoAsJoGZq9d3YQPaurJWxE9AOiiud5A8K0FdKUMDyD49h0wr7bnfo5vfQCFBYKqV2a7RPOZuB/f7G8X0Q6TgXh0g7MLOT/qEcfTwbjKDrfMt9vFtx31M6BDOJrJr+lHFsC5t8eFT6zJQ4tCVoCuGTEqUpE1CzNkg4DJCeeAgE//0yagdhwE/IWCOCC4g4C//P1ea0LLvwjq+DvCRNJ/reuC+E+B49LwRUpl3HbUdlwCCG8pTUQSZWXtK1uYhSDNgsi+svmAsQiRhxgOFjv9lpbEABAnkE9AYAA4H3MptUwkOQFH4aMSSKaYJTrkA8IDbR4A8CK/MBQkBgIGgNqWgCgAWPiAVAfaGvAulUtWdgEzp2CEE9E+gOMPenfK43YAMO1JOcpgXQ9elYLYHAScBKBdGEABfJvOeC0KwoAQu98MbEoG215sOFQkYAFcfkkUCoKALACQ5JQpMKwp1MLM6QO86Sij6z2F3ky8pjKjzVRqbCUOay7EQICiE4aANURVO1D1FgQR+qBYeUuoD4CIM42s+zkOBB7MjqYjz/IwZ1P9doSHw7tZLFTA2xIyEJyUxYphiy1QsdByUJNXWQqKHRxC86ld64IgDgI61Iaq9mKhW5ckJl+gUZqI6THQ6hM+CQY6/35ABhjXVEZ8ARWej6wFOIGeAAAAAElFTkSuQmCC")}',
      '.cr-whale{display:inline-block;flex:0 0 auto;background:currentColor;-webkit-mask:var(--cr-whale) center/contain no-repeat;mask:var(--cr-whale) center/contain no-repeat}',
      '.cr-float-mark .cr-whale,.cr-float-pill .cr-whale{width:15px;height:15px}',

      /* 列头：11px 大写标签，和素材库里的 Channels / Activity 一个层级 */
      '.cr-col-head{min-height:0;padding:14px 12px 6px;gap:6px}',
      '.cr-col-title{font-size:11px;line-height:1.4;letter-spacing:.06em;text-transform:uppercase;color:var(--cr-caption);font-weight:500}',
      '.cr-count{font-size:11px;color:var(--cr-caption)}',
      '.cr-col-foot{padding:10px 12px 12px;gap:6px;border-top:1px solid var(--cr-line)}',

      /* 房间行：8px 圆角、24px 徽记、选中用一层填充，不再画竖条 */
      '.cr-rooms{padding:0 8px 10px;gap:2px}',
      '.cr-room{gap:8px;align-items:center;padding:6px 8px;border-radius:var(--cr-r);overflow:visible}',
      '.cr-room:hover{background:var(--cr-fill-1)}',
      '.cr-room.cr-active{background:var(--cr-fill-3)}',
      '.cr-room.cr-active::before{content:none}',
      '.cr-room-avatar{width:24px;height:24px;border:0;background:var(--cr-fill-2);color:var(--cr-body);font-size:11px;font-weight:500}',
      '.cr-room-top{gap:6px}',
      '.cr-room-name{font-size:13px;font-weight:500;color:var(--cr-fg)}',
      '.cr-room-time{font-size:11px;color:var(--cr-caption)}',
      '.cr-room-preview{margin-top:1px;font-size:11px;line-height:1.45;color:var(--cr-caption)}',

      /* 房间头：15px 标题 + 12px 一句说明，右侧是 28px 的文字键 */
      '.cr-room-head{padding:11px 16px;gap:6px;border-bottom:1px solid var(--cr-line)}',
      '.cr-room-head-top{gap:8px;align-items:center;min-width:0}',
      '.cr-room-title{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cr-room-title{font-size:15px;font-weight:500;letter-spacing:-.01em;color:var(--cr-fg)}',
      '.cr-room-head-sub{margin-top:2px;font-size:12px;line-height:1.5;color:var(--cr-caption)}',

      /* 消息：32px 徽记、13px 署名、14px 正文；自己那边是一块 14px 圆角的填充 */
      '.cr-flow{padding:18px 16px 6px;gap:22px}',
      '.cr-day{gap:10px;font-size:11px;color:var(--cr-caption)}',
      '.cr-msg{gap:10px}',
      '.cr-msg.cr-cont{margin-top:-10px}',
      '.cr-avatar{width:32px;height:32px;border:0;background:var(--cr-fill-2);color:var(--cr-body);font-size:11px;font-weight:500}',
      '.cr-msg-meta{gap:6px}',
      '.cr-msg-name{font-size:13px;font-weight:500;color:var(--cr-fg)}',
      '.cr-msg-time{font-size:11px;color:var(--cr-caption)}',
      '.cr-msg-text{font-size:14px;line-height:1.7;color:var(--cr-body);max-width:min(620px,100%)}',
      '.cr-msg.cr-mine .cr-msg-text{background:var(--cr-fill-3);border:0;border-radius:var(--cr-r-xl);padding:8px 12px;color:var(--cr-fg)}',
      '.cr-msg.cr-mine .cr-avatar{background:var(--cr-fill-3);color:var(--cr-fg)}',
      '.cr-mention{color:var(--cr-fg);font-weight:500;text-decoration:underline;text-decoration-color:var(--cr-line-strong);text-underline-offset:3px}',
      '.cr-thinking{padding-left:42px;font-size:12px;color:var(--cr-caption);gap:6px}',
      '.cr-hint{margin-left:42px;border-left-color:var(--cr-line);font-size:12px;color:var(--cr-caption)}',
      '.cr-dot{width:6px;height:6px;opacity:.75;animation:cr-pulse 1.4s ease-in-out infinite}',
      '.cr-dot:nth-child(2),.cr-dot:nth-child(3){display:none}',
      '@keyframes cr-pulse{0%,100%{opacity:.35}50%{opacity:.95}}',

      /* 输入器：一整块 14px 圆角的壳体，里面 32px 的键 */
      '.cr-composer{padding:10px 16px 14px;gap:8px}',
      '.cr-composer-identity{font-size:11px;color:var(--cr-caption)}',
      '.cr-composer-identity b{font-size:12px;font-weight:500;color:var(--cr-body)}',
      '.cr-input-shell{padding:6px 6px 6px 12px;border:1px solid transparent;border-radius:var(--cr-r-xl);background:var(--cr-fill-1)}',
      '.cr-input-shell:focus-within{border-color:var(--cr-line-strong);background:var(--cr-fill-1)}',
      '.cr-textarea{font-size:14px;line-height:1.6}',
      '.cr-mention-btn{width:28px;height:28px;border-radius:var(--cr-r)}',
      '.cr-send{height:32px;min-width:32px;padding:0 12px;border-radius:var(--cr-r);background:var(--cr-accent);color:var(--cr-on-accent);font-size:12px;font-weight:500;transition:transform .1s cubic-bezier(.23,1,.32,1),background-color .15s ease-out}',
      '.cr-send:hover{filter:none;background:color-mix(in srgb,var(--cr-accent) 86%,var(--cr-fg))}',
      '.cr-send:active{transform:scale(.97)}',
      '.cr-composer-foot{font-size:11px;color:var(--cr-caption);min-height:18px}',

      /* 成员列：24px 徽记 + 13px 名字 + 11px 副标题，分组标题回到 11px 大写 */
      '.cr-members{padding:0 8px 12px;gap:2px}',
      '.cr-group-label{margin-top:0;padding:12px 8px 4px;border-top:0;font-size:11px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--cr-caption)}',
      '.cr-member{gap:8px;padding:6px 8px;border-radius:var(--cr-r)}',
      '.cr-member:hover{background:var(--cr-fill-1)}',
      '.cr-member .cr-avatar{width:24px;height:24px;border:0;background:var(--cr-fill-2);color:var(--cr-body);font-size:10px}',
      '.cr-member-name{font-size:13px;color:var(--cr-fg)}',
      '.cr-member-role{font-size:11px;color:var(--cr-caption)}',

      /* 胶囊 / 徽标 / 分段控制：一律是填充，不再用描边堆盒子 */
      '.cr-chip,.cr-agent-chip{height:22px;line-height:22px;padding:0 6px;border:0;border-radius:var(--cr-r-sm);background:var(--cr-fill-1);color:var(--cr-body);font-size:11px}',
      '.cr-chip.cr-lan,.cr-lan{border:0;background:var(--cr-fill-1);color:var(--cr-body)}',
      '.cr-badge{min-width:18px;height:18px;padding:0 5px;font-size:11px;font-weight:500;background:var(--cr-accent,var(--dsw-alias-brand-primary,#f9fafb));color:var(--cr-on-accent,var(--dsw-alias-bg-base,#151517))}',
      '.cr-btn{height:28px;padding:0 10px;border-radius:var(--cr-r);font-size:12px}',
      '.cr-btn.cr-ghost{height:28px;padding:0 8px}',
      '.cr-auth{padding:10px 8px 12px;border-top:1px solid var(--cr-line);gap:8px}',
      '.cr-auth-head{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--cr-caption)}',
      '.cr-auth-seg{height:30px;padding:2px;gap:2px;border:0;border-radius:var(--cr-r);background:var(--cr-fill-1)}',
      '.cr-auth-btn{height:26px;border:0;border-radius:var(--cr-r-sm);font-size:12px;color:var(--cr-muted)}',
      '.cr-auth-btn.cr-on{background:var(--cr-fill-3);color:var(--cr-fg)}',

      /* 浮窗：40px 胶囊（鲸 + 房间 + 最后一句 + 未读），展开是 14px 圆角卡片 */
      '.cr-float-card{width:380px;border:1px solid var(--cr-line);border-radius:var(--cr-r-xl);background:var(--cr-surface)}',
      '.cr-float-head{min-height:48px;padding:8px 8px 8px 12px;gap:8px}',
      '.cr-float-mark{width:24px;height:24px;border-radius:var(--cr-r-sm);background:var(--cr-fill-2);color:var(--cr-fg)}',
      '.cr-float-pill{height:40px;max-width:304px;padding:0 10px 0 6px;gap:8px;border-radius:999px;background:var(--cr-surface);box-shadow:var(--cr-shadow-2);transition:transform .12s ease-out}',
      '.cr-float-pill:hover{transform:translateY(-1px)}',
      '.cr-float-pill:active{transform:translateY(0) scale(.985)}',
      '.cr-float-pill .cr-float-mark{width:28px;height:28px;border-radius:999px}',
      '.cr-float-pill-name{font-size:12px;font-weight:500}',
      '.cr-float-pill-say{font-size:11px;color:var(--cr-caption)}',
      '.cr-float-msg .cr-msg-text{font-size:13px;line-height:1.6}',
      '.cr-float-msg .cr-avatar{width:24px;height:24px;font-size:10px}',
      '.cr-float-thinking{padding-left:34px}',
      '.cr-float-hint{margin-left:34px}',

      /* 本机授权卡：右下角、不盖住对话；一块黑卡，标题前一颗 6px 琥珀点。
       * 依据 AI Chat 5：说明 → 原话 → 折叠的完整请求 → 两个按钮。 */
      '.cr-approve{left:auto;right:16px;bottom:80px;top:auto;transform:none;width:min(408px,calc(100vw - 32px));padding:12px;gap:10px;border:1px solid var(--cr-line);border-radius:var(--cr-r-xl);background:var(--cr-surface);box-shadow:var(--cr-shadow-2)}',
      '.cr-approve-eyebrow{flex:1;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--cr-caption)}',
      '.cr-approve-eyebrow::before{content:"";display:inline-block;width:6px;height:6px;margin-right:6px;border-radius:50%;background:var(--cr-warn);vertical-align:1px}',
      '.cr-approve-who{font-size:13px;font-weight:500;line-height:1.5;color:var(--cr-fg)}',
      '.cr-approve-meta{font-size:11px;line-height:1.6;color:var(--cr-caption)}',
      '.cr-approve-body{max-height:120px;padding:10px;border-radius:var(--cr-r-lg);background:var(--cr-fill-1);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.65;color:var(--cr-body)}',
      '.cr-approve-quote{padding-left:10px;border-left:2px solid var(--cr-line-strong);font-size:12px;line-height:1.65;color:var(--cr-body)}',
      '.cr-approve-label{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--cr-caption)}',
      '.cr-approve-foot .cr-btn{height:32px;padding:0 12px}',
      '.cr-approve-hint{font-size:11px;line-height:1.5;color:var(--cr-caption);text-align:right}',
      '.cr-toast{border-radius:var(--cr-r-xl);border-color:var(--cr-line);padding:10px 12px}',
      '.cr-toast-name{font-size:11px;color:var(--cr-caption)}',
      /* 首屏：一块安静的居中说明，顶上一枚 36px 鲸（形状与胶囊、浮窗同一个蒙版）。 */
      '.cr-first{flex:1;justify-content:center;align-items:center;padding:32px}',
      '.cr-first-inner{width:100%;max-width:420px;margin:0 auto;display:flex;flex-direction:column;gap:10px}',
      '.cr-first-inner::before{content:"";width:36px;height:36px;margin-bottom:6px;background:var(--cr-fg);-webkit-mask:var(--cr-whale) center/contain no-repeat;mask:var(--cr-whale) center/contain no-repeat;opacity:.92}',
      '.cr-first-title{font-size:15px;font-weight:500;line-height:1.4;letter-spacing:-.01em;color:var(--cr-fg)}',
      '.cr-first-text{margin:0;font-size:13px;line-height:1.75;color:var(--cr-body)}',
      '.cr-first-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}',
      '.cr-first-note{margin:0;font-size:11px;line-height:1.65;color:var(--cr-caption)}',
      /* 正文列的最大宽度由 --cr-flow-max 控制（可拖拽调整，见 RoomsPanel 的拖拽手柄），
       * 默认 780px：一行别拉成一千多像素的横条；拖动变宽后仍居中，只是显示更多。 */
      '.cr-flow{align-items:center}',
      '.cr-flow > *{width:100%;max-width:var(--cr-flow-max,780px)}',
      '.cr-composer > *{width:100%;max-width:var(--cr-flow-max,780px);margin-left:auto;margin-right:auto}',
      /* 动效只做「出现」这一下：抬 4px + 淡入 180ms，落定就不再动。 */
      '@media (prefers-reduced-motion:no-preference){.cr-msg{animation:cr-rise .18s ease-out both}@keyframes cr-rise{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}}',
      '.cr-room,.cr-btn,.cr-chip,.cr-auth-btn,.cr-member{transition:background-color .15s ease-out,color .15s ease-out}',
      /* ---- 虎鲸的颜色：头像与取色块 ------------------------------------- */
      /* 头像 = 他那只会换色的鲸。底盘是同一色 14% 的淡底 —— 一深一浅两个人在
       * 小尺寸下也分得开，但不会各自发亮成八种荧光。
       * 选择器写全四种场合：`.cr-msg.cr-mine .cr-avatar` 那几条旧规则权重更高，
       * 只写 `.cr-avatar` 的话「我」的气泡里还会是中性灰。 */
      '.cr-avatar,.cr-msg .cr-avatar,.cr-msg.cr-mine .cr-avatar,.cr-member .cr-avatar{background:color-mix(in srgb,currentColor 14%,transparent);color:inherit}',
      '.cr-avatar .cr-whale{width:16px;height:16px;opacity:.95}',
      '.cr-member .cr-avatar .cr-whale{width:13px;height:13px}',
      '.cr-float-msg .cr-avatar .cr-whale{width:13px;height:13px}',
      /* 取色块：24px 的点击区里画 12px 的圆点。选中只把圆点调实 + 一圈同色淡环，
       * 不描边 —— 描边在深色底上会被误读成「不可用」。 */
      '.cr-sw{display:flex;flex-wrap:wrap;gap:2px;margin:0 -2px}',
      '.cr-sw-dot{width:24px;height:24px;display:flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:50%;background:none;cursor:pointer;color:inherit}',
      '.cr-sw-core{width:12px;height:12px;border-radius:50%;background:currentColor;opacity:.5;transition:opacity .15s ease-out,box-shadow .15s ease-out}',
      '.cr-sw-dot:hover .cr-sw-core{opacity:.8}',
      '.cr-sw-dot:focus-visible{outline:1.5px solid var(--cr-fg);outline-offset:1px}',
      '.cr-sw-dot[aria-pressed="true"] .cr-sw-core{opacity:1;box-shadow:0 0 0 1.5px color-mix(in srgb,currentColor 45%,transparent)}',
      '.cr-color-row{display:flex;flex-direction:column;gap:4px;margin-top:2px}',
      '.cr-form-row{display:flex;flex-direction:column;gap:4px}',
      '.cr-form-label{font-size:11px;line-height:1.4;color:var(--cr-caption)}',

      /* ==================================================================
       * 2026-11-25 消息界面可读性优化：让「谁说的」一眼看得清。
       *   每位成员的颜色由 MessageRow 写成 --cr-author，下面所有上色都读它。
       *   别人的消息：左对齐气泡 + 作者色左竖条 + 名字前同色小圆点 + 名字同色；
       *   自己的消息：右对齐气泡 + 右侧尾角 + 同样用「我」的颜色，但靠方向区分；
       *   连续同一人：竖条不断、圆角收平，读成「同一个人的一段话」。
       * 只加一层纯视觉样式，DOM 结构、数据与所有交互一律不动。
       * ================================================================== */
      '.cr-msg{--cr-author:var(--cr-accent);position:relative}',
      /* 别人的消息：淡淡的作者色底 + 3px 作者色左竖条，成块、成段、彼此分得开。 */
      '.cr-msg:not(.cr-mine) .cr-msg-text{box-sizing:border-box;padding:8px 12px;background:color-mix(in srgb,var(--cr-author) 9%,var(--cr-surface));border:1px solid color-mix(in srgb,var(--cr-author) 16%,var(--cr-line));border-left:3px solid color-mix(in srgb,var(--cr-author) 82%,var(--cr-fg));border-radius:4px 14px 14px 4px}',
      /* 名字：作者色向正文色混合 —— 深色底上留得住辨识，浅色底上也不会糊成一片。 */
      '.cr-msg:not(.cr-mine) .cr-msg-name{color:color-mix(in srgb,var(--cr-author) 68%,var(--cr-fg))}',
      /* 名字前一颗小圆点：不靠读字也能顺着颜色把同一个人的话串起来。 */
      '.cr-msg-name::before{content:"";display:inline-block;width:7px;height:7px;margin-right:6px;border-radius:50%;vertical-align:1px;background:var(--cr-author)}',
      /* 自己的消息：右对齐填充气泡，四角统一柔和，只在右下留一个很小的收口当「尾」；
       * 不再用一条加粗的右边框（近白作者色时那会变成一道刺眼的白边、下角也显硬）。 */
      '.cr-msg.cr-mine .cr-msg-text{box-sizing:border-box;padding:8px 12px;background:color-mix(in srgb,var(--cr-author) 16%,var(--cr-surface));border:1px solid color-mix(in srgb,var(--cr-author) 20%,var(--cr-line));border-radius:14px 14px 6px 14px;color:var(--cr-fg)}',
      '.cr-msg.cr-mine .cr-msg-name{color:color-mix(in srgb,var(--cr-author) 72%,var(--cr-fg))}',
      /* 连续同一人：竖条连着、上沿圆角收平，读成一段而不是两条独立消息。 */
      '.cr-msg.cr-cont .cr-msg-text{border-top-left-radius:2px;border-top-right-radius:2px}',
      /* 行距按「段」呼吸：不同人拉开，同一人连续时贴紧。 */
      '.cr-flow{gap:16px}',
      '.cr-msg.cr-cont{margin-top:-8px}',
      /* 悬停时整条气泡提亮一档，回头在某一条上找上下文更省力。 */
      '.cr-msg:not(.cr-mine):hover .cr-msg-text{background:color-mix(in srgb,var(--cr-author) 14%,var(--cr-surface))}',
      /* 头像加一圈同色淡环，和名字、竖条是同一套颜色。 */
      '.cr-avatar{box-shadow:0 0 0 1px color-mix(in srgb,var(--cr-author) 26%,transparent)}',
      /* 浮窗里结构相同，内边距与圆角整体收一号。 */
      '.cr-float-msg .cr-msg-text{padding:6px 10px}',
      '.cr-float-msg.cr-mine .cr-msg-text{padding:6px 10px;border-radius:12px 12px 5px 12px}',

      /* ==================================================================
       * 2026-11-25 房间列表可折叠：收起后左边留一条 56px 窄轨（展开键 + 每间屋子的头像），
       * 把整片宽度让给消息区。状态记在 localStorage（见 readNavCollapsed）。
       * ================================================================== */
      '.cr-grid.cr-nav-collapsed{grid-template-columns:56px minmax(0,1fr) 264px}',
      '.cr-grid.cr-nav-collapsed.cr-grid-first{grid-template-columns:56px minmax(0,1fr)}',
      '.cr-nav-rail{align-items:center;gap:10px;padding:10px 0 0;overflow:hidden}',
      /* 展开键和列头的收起键都走 .cr-btn 那套边框/高度，一致性由基类保证，这里只收成方形。 */
      '.cr-nav-rail-expand,.cr-nav-toggle{width:28px;min-width:28px;height:28px;padding:0;justify-content:center;flex:0 0 auto;color:var(--cr-muted);font-size:14px}',
      '.cr-nav-rail-expand:hover,.cr-nav-toggle:hover{color:var(--cr-fg)}',
      '.cr-chevron{display:block;line-height:1}',
      /* 收起态的会话列表：竖排头像，每个都是一枚带边框的圆，和展开时房间列表的徽记同一种。 */
      '.cr-rail-rooms{display:flex;flex-direction:column;align-items:center;gap:8px;width:100%;padding:2px 0 8px;overflow-y:auto;overflow-x:hidden}',
      '.cr-rail-room{position:relative;width:38px;height:38px;padding:0;border:0;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:999px;flex:0 0 auto}',
      '.cr-rail-room:hover{background:var(--cr-fill-1)}',
      '.cr-rail-avatar{width:32px;height:32px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;background:var(--cr-surface-3);border:1px solid var(--cr-line);color:var(--cr-fg)}',
      '.cr-rail-room.cr-on .cr-rail-avatar{border-color:color-mix(in srgb,var(--cr-accent) 60%,var(--cr-line));box-shadow:0 0 0 2px color-mix(in srgb,var(--cr-accent) 28%,transparent)}',
      '.cr-rail-badge{position:absolute;top:0;right:0;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--cr-accent,var(--dsw-alias-brand-primary,#f9fafb));color:var(--cr-on-accent,var(--dsw-alias-bg-base,#151517));font-size:10px;font-weight:600;display:flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}',
      /* 窄屏（成员列已隐藏）时，收起就是「窄轨 + 消息」两列，别给隐藏的第三列留空位。 */
      '@media (max-width:980px){.cr-grid.cr-nav-collapsed,.cr-grid.cr-nav-collapsed.cr-grid-first{grid-template-columns:56px minmax(0,1fr)}}',

      /* ==================================================================
       * 2026-11-25 「回到最新」浮起提示重做。
       * 之前它被 `.cr-flow > *{width:100%}` 撑成一条横贯的宽条，压着消息、很难看。
       * 现在收成一颗居中的小胶囊：向下箭头 + 文案 +（有新消息时）一颗数字徽标。
       * ================================================================== */
      '.cr-jump{position:sticky;bottom:12px;align-self:center;flex:0 0 auto;display:inline-flex;align-items:center;gap:8px;width:auto;max-width:none;height:auto;padding:12px 18px;border:1px solid var(--cr-line-strong);border-radius:999px;background:var(--cr-surface);color:var(--cr-fg);font:inherit;font-size:13px;line-height:1;cursor:pointer;box-shadow:var(--cr-shadow-2);transition:transform .1s ease-out,background-color .15s ease-out}',
      '.cr-jump:hover{background:var(--cr-hover);transform:translateY(-1px)}',
      '.cr-jump:active{transform:translateY(0) scale(.98)}',
      '.cr-jump-arrow{font-size:15px;line-height:1;opacity:.9}',
      '.cr-jump-label{white-space:nowrap}',
      '.cr-jump-fresh{display:inline-flex;align-items:center;gap:7px}',
      '.cr-jump-sep{opacity:.5}',
      '.cr-jump-more{color:var(--cr-muted);white-space:nowrap}',
      '.cr-jump-badge{min-width:22px;height:22px;padding:0 6px;border-radius:999px;background:var(--cr-accent,var(--dsw-alias-brand-primary,#f9fafb));color:var(--cr-on-accent,var(--dsw-alias-bg-base,#151517));font-size:12px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}',

      /* ==================================================================
       * 2026-11-25 聊天区可拖宽：正文右缘一枚隐形手柄，左右拖动改 --cr-flow-max，
       * 内容仍居中、只是显示更宽/更窄；松手落盘（见 startFlowResize / readFlowMax）。
       * ================================================================== */
      '.cr-col-flow{position:relative}',
      /* 抓手竖向居中、只占中间一段：上下都不碰房间头的分隔线和底部输入区，
       * 横向再往正文外侧让一点，和自己的头像留出间距。 */
      '.cr-flow-resize{position:absolute;z-index:6;top:50%;height:min(56%,380px);transform:translateY(-50%);right:max(6px,calc((100% - var(--cr-flow-max,780px)) / 2 - 25px));width:14px;display:flex;align-items:center;justify-content:center;cursor:col-resize;touch-action:none}',
      '.cr-flow-resize::before{content:"";width:3px;height:100%;border-radius:999px;background:transparent;transition:background-color .15s ease-out}',
      '.cr-col-flow:hover .cr-flow-resize::before{background:var(--cr-line)}',
      '.cr-flow-resize:hover::before,.cr-flow-resize:active::before{background:var(--cr-line-strong)}',
    ].join('\n')

    /* ------------------------------------------------------------------ 工具 */

    var t = (key) => ZH[key] ?? key

    function bindLocale(ctx) {
      try {
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: ZH, en: EN })
        }, NS + ':dictionaries')
        return ctx.locale.bind(NS)
      } catch (error) {
        console.warn('[dsh-chatroom] 字典注册失败，改用中文字面量：' + String((error && error.message) || error))
        return (key) => ZH[key] ?? key
      }
    }

    var pad = (n) => (n < 10 ? '0' + n : String(n))
    function clock(iso) {
      var d = new Date(iso)
      if (Number.isNaN(d.getTime())) return ''
      return pad(d.getHours()) + ':' + pad(d.getMinutes())
    }
    var initial = (name) => (name ? String(name).trim().slice(0, 1).toUpperCase() : '?')

    /* 虎鲸的几种颜色。
     *
     * 一个人、一个 agent 各挑一只 —— 成员列、消息行、浮窗里靠它认「这条是谁说的」。
     * id 是存档里写的那个值（宿主只认真实存在的 id，见 src/host/palette.js），
     * 色值只活在这里：换主题、调色都不用动任何人的 state.json。
     * 两份 id 列表由 test/palette.test.mjs 对着，改一处漏改另一处会红。
     *
     * 取值都压在「近黑底上看得清、彼此分得开」的区间：最低的一档对 #151517 也有 6:1，
     * 不和正文抢注意力，但也没淡到看不出是谁。 */
    var WHALE = [
      ['frost', '#e9edf2'],
      ['steel', '#9aa6b4'],
      ['sky', '#7fb3f5'],
      ['teal', '#5ec8c2'],
      ['moss', '#8fc97c'],
      ['amber', '#e6b165'],
      ['coral', '#ea8b7c'],
      ['violet', '#b495e8'],
    ]
    var WHALE_IDS = WHALE.map((entry) => entry[0])
    function whaleHex(id) {
      for (var i = 0; i < WHALE.length; i += 1) if (WHALE[i][0] === id) return WHALE[i][1]
      return WHALE[0][1]
    }
    /** 成员该用哪种颜色：认 id，认不出来就退回「霜白」，绝不画一个没有颜色的鲸。 */
    function whaleOf(member) {
      if (!member || typeof member.color !== 'string') return WHALE[0][1]
      for (var i = 0; i < WHALE.length; i += 1) if (WHALE[i][0] === member.color) return WHALE[i][1]
      return WHALE[0][1]
    }
    function whaleName(tr, id) {
      var index = WHALE_IDS.indexOf(id)
      var names = String(tr('whaleColors') || '').split(',')
      return (index >= 0 && names[index]) || id
    }

    /* 消息流的日期分隔：同一天归到一块，跨天插一条「11月3日」。
     * 不写死中文月日 —— 按宿主页面语言取，英文界面下就是 "Nov 3"。 */
    var dayKey = (iso) => {
      var d = new Date(iso)
      if (Number.isNaN(d.getTime())) return ''
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    }
    function dayLabel(iso) {
      var d = new Date(iso)
      if (Number.isNaN(d.getTime())) return ''
      var lang = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || 'zh'
      var en = String(lang).toLowerCase().indexOf('en') === 0
      try {
        return d.toLocaleDateString(en ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric' })
      } catch (error) {
        return dayKey(iso)
      }
    }
    /* 同一个人连说几句、间隔又短，就并成一组：头像和署名只留第一句。
     * 3 分钟是群聊里「还在说同一件事」的经验值，再长就该重新署名。 */
    var GROUP_MS = 3 * 60 * 1000
    function sameBurst(previous, message) {
      if (!previous) return false
      if (previous.authorId !== message.authorId) return false
      if (dayKey(previous.at) !== dayKey(message.at)) return false
      var gap = new Date(message.at).getTime() - new Date(previous.at).getTime()
      return gap >= 0 && gap < GROUP_MS
    }

    var escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    /** 极简 Markdown：**粗体**、`代码`、@名字。群聊里够用，别把整颗 markdown 引擎搬进来。 */
    function renderInline(text, members, keyPrefix) {
      var names = (members || []).map((m) => m.name).filter(Boolean).sort((a, b) => b.length - a.length)
      var out = []
      var lines = String(text || '').split('\n')
      lines.forEach((line, lineIndex) => {
        if (lineIndex > 0) out.push('\n')
        var pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g
        var cursor = 0
        var match
        while ((match = pattern.exec(line)) !== null) {
          if (match.index > cursor) out.push(...splitMentions(line.slice(cursor, match.index), names, keyPrefix + ':' + lineIndex + ':' + cursor))
          var token = match[0]
          if (token.startsWith('**')) {
            out.push(h('strong', { key: keyPrefix + ':b:' + match.index }, token.slice(2, -2)))
          } else {
            out.push(h('code', { key: keyPrefix + ':c:' + match.index }, token.slice(1, -1)))
          }
          cursor = match.index + token.length
        }
        if (cursor < line.length) out.push(...splitMentions(line.slice(cursor), names, keyPrefix + ':' + lineIndex + ':t'))
      })
      return out
    }

    function splitMentions(text, names, keyPrefix) {
      if (!names.length) return [text]
      var pattern = new RegExp('@(' + names.map(escapeRegExp).join('|') + ')', 'g')
      var out = []
      var cursor = 0
      var match
      var index = 0
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > cursor) out.push(text.slice(cursor, match.index))
        out.push(h('span', { className: 'cr-mention', key: keyPrefix + ':m:' + index }, match[0]))
        index += 1
        cursor = match.index + match[0].length
      }
      if (cursor < text.length) out.push(text.slice(cursor))
      return out
    }

    /** 屋里有多少成员是从别的机器进来的：底栏与成员列都要说同一件事。 */
    var lanCount = (members) => (members || []).filter((member) => member.origin && member.origin.kind === 'lan').length

    /** 本机授权的三档：默认只读，逐级放宽（顺序就是界面上的顺序）。 */
    var AUTH_LEVELS = [
      { id: 'readonly', label: 'authReadonly', note: 'authNoteReadonly' },
      { id: 'ask', label: 'authAsk', note: 'authNoteAsk' },
      { id: 'full', label: 'authFull', note: 'authNoteFull' },
    ]

    /**
     * 悬浮窗的位置要留得住，但也不能留到屏幕外面去。
     *
     * 拖到右下角、把窗口改窄、或者干脆关掉页面重开 —— 这三种情况都会让一个「记住的坐标」
     * 变成一块点不到、拖不回来的浮窗。所以所有坐标都要过一道夹取：至少留出 8px 边距，
     * 并且整块浮窗都在视口里。夹的是坐标，不是用户意图，所以夹完就顺手存下来。
     */
    var FLOAT_MARGIN = 8
    var FLOAT_POS_KEY = 'dsh-chatroom:float-pos:v1'

    /* 房间列表折叠状态要记住：下次打开面板还是上次那样。
     * 只存一个布尔，用 localStorage，复用下面的 floatStorage() 兜底（隐私模式取不到就默认展开）。 */
    var NAV_COLLAPSED_KEY = 'dsh-chatroom:nav-collapsed:v1'
    function readNavCollapsed() {
      var box = floatStorage()
      if (!box) return false
      try {
        return box.getItem(NAV_COLLAPSED_KEY) === '1'
      } catch (error) {
        return false
      }
    }
    function saveNavCollapsed(collapsed) {
      var box = floatStorage()
      if (!box) return
      try {
        box.setItem(NAV_COLLAPSED_KEY, collapsed ? '1' : '0')
      } catch (error) {
        /* 记不住不算错 */
      }
    }

    /* 聊天区的最大宽度也记住：拖宽一次，下次打开面板还是这个宽度。 */
    var FLOW_MAX_KEY = 'dsh-chatroom:flow-max:v1'
    var FLOW_MAX_DEFAULT = 780
    var FLOW_MAX_MIN = 420
    function readFlowMax() {
      var box = floatStorage()
      if (!box) return FLOW_MAX_DEFAULT
      try {
        var value = Number(box.getItem(FLOW_MAX_KEY))
        if (!Number.isFinite(value) || value <= 0) return FLOW_MAX_DEFAULT
        return Math.max(FLOW_MAX_MIN, Math.round(value))
      } catch (error) {
        return FLOW_MAX_DEFAULT
      }
    }
    function saveFlowMax(value) {
      var box = floatStorage()
      if (!box) return
      try {
        box.setItem(FLOW_MAX_KEY, String(Math.round(value)))
      } catch (error) {
        /* 记不住不算错 */
      }
    }

    function clampFloat(x, y, width, height) {
      var viewportWidth = (typeof window !== 'undefined' && window.innerWidth) || 1440
      var viewportHeight = (typeof window !== 'undefined' && window.innerHeight) || 900
      var maxX = Math.max(FLOAT_MARGIN, viewportWidth - width - FLOAT_MARGIN)
      var maxY = Math.max(FLOAT_MARGIN, viewportHeight - height - FLOAT_MARGIN)
      var pick = (value, max) => Math.round(Math.min(Math.max(Number.isFinite(value) ? value : FLOAT_MARGIN, FLOAT_MARGIN), max))
      return { x: pick(x, maxX), y: pick(y, maxY) }
    }

    function floatStorage() {
      try {
        return typeof window !== 'undefined' ? window.localStorage : null
      } catch (error) {
        return null // 隐私模式下访问 localStorage 会抛，记不住位置不至于让浮窗打不开
      }
    }

    function readFloatPos() {
      var box = floatStorage()
      if (!box) return null
      try {
        var raw = JSON.parse(box.getItem(FLOAT_POS_KEY) || 'null')
        if (!raw || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return null
        return { x: raw.x, y: raw.y } // 视口可能已经变了，等浮窗挂上来再夹
      } catch (error) {
        return null
      }
    }

    function saveFloatPos(position) {
      var box = floatStorage()
      if (!box) return
      try {
        box.setItem(FLOAT_POS_KEY, JSON.stringify({ x: position.x, y: position.y }))
      } catch (error) {
        /* 存不下就算了，位置只在这一次会话里有效 */
      }
    }

    function clearFloatPos() {
      var box = floatStorage()
      if (!box) return
      try {
        box.removeItem(FLOAT_POS_KEY)
      } catch (error) {
        /* 同上 */
      }
    }

    /* -------------------------------------------------------------- 数据层 */

    function createRpc(ctx) {
      var callId = 0

      /** 客户端的连接服务：有的版本挂在 ctx.connection，有的只能 ctx.get 取。 */
      function connectionOf() {
        try {
          if (ctx.connection && ctx.connection.rpc) return ctx.connection
        } catch (error) {
          /* 没注入时属性访问会抛，不是错误，接着往下找 */
        }
        try {
          var viaGet = typeof ctx.get === 'function' ? ctx.get('connection') : null
          if (viaGet && viaGet.rpc) return viaGet
        } catch (error) {
          /* 同上 */
        }
        return null
      }

      function unwrap(reply) {
        if (!reply || reply.ok !== true) {
          var error = (reply && reply.error) || {}
          throw Object.assign(new Error(error.message || '请求未完成'), { code: error.code || 'rpc_failed' })
        }
        return reply.value
      }

      return async function rpc(method, payload, timeoutMs) {
        var signal = AbortSignal.timeout(timeoutMs || 30000)
        var connection = connectionOf()
        if (connection) {
          return unwrap(await connection.rpc.call('/api', 'dsh.chatroom/' + method, payload || {}, signal))
        }
        // 回落：这个包自己的 /api 路由本来就是同源的，浏览器带着 Cookie 直接 POST 就行
        // （同宿主里别的客户端插件走的就是这条路）。取不到连接服务不该让整个面板停摆。
        if (typeof fetch !== 'function') {
          throw Object.assign(new Error('连接服务不可用'), { code: 'connection_unavailable' })
        }
        callId += 1
        var response = await fetch('/api/dsh.chatroom/' + method, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: 'rpc-' + Date.now().toString(36) + '-' + callId.toString(36),
            method: 'dsh.chatroom/' + method,
            payload: payload || {},
          }),
          signal: signal,
        })
        if (!response || !response.ok) {
          throw Object.assign(new Error('请求未完成（HTTP ' + ((response && response.status) || 0) + '）'), {
            code: 'http_' + ((response && response.status) || 0),
          })
        }
        return unwrap(await response.json())
      }
    }

    function createStore(rpc) {
      var listeners = new Set()
      var state = {
        snapshot: null,
        error: '',
        loading: true,
        panelMounted: false,
        floatOpen: false,
        floatPos: readFloatPos(),
        notice: null,
        pending: [],
        // 草稿按屋子分开存：输入框里的话是「这间屋子还没说出口的那句」，
        // 换屋子看一眼别的屋、回来还得在。以前只有一份全局草稿，换屋子会跟着走 ——
        // 面板和浮窗都这样，人在 B 屋里一按回车就发进了 B 屋，说的却是 A 屋的事。
        drafts: {},
      }
      var watching = false
      var stopped = false

      function get() {
        return state
      }
      function set(patch) {
        state = Object.assign({}, state, patch)
        for (var listener of listeners) {
          try {
            listener()
          } catch (error) {
            console.warn('[dsh-chatroom] listener failed: ' + String(error))
          }
        }
      }
      function subscribe(listener) {
        listeners.add(listener)
        return function () {
          listeners.delete(listener)
        }
      }

      function activeRoom() {
        var snapshot = state.snapshot
        if (!snapshot) return null
        return snapshot.rooms.find((room) => room.id === snapshot.activeRoomId) || snapshot.rooms[0] || null
      }

      function totalUnread() {
        var snapshot = state.snapshot
        if (!snapshot) return 0
        return snapshot.rooms.reduce((sum, room) => sum + (room.unread || 0), 0)
      }

      /** 这间屋子还没发出去的草稿。面板与浮窗同一个房间共用一份 —— 就是同一句话。 */
      function draftOf(roomId) {
        return (roomId && state.drafts[roomId]) || ''
      }

      /**
       * 改草稿。只存非空的那几份：空字符串等于「没有草稿」，
       * 不然每次回车发完都要在表里留一个空 key。
       */
      function setDraft(roomId, value) {
        if (!roomId) return
        var text = typeof value === 'string' ? value : ''
        var drafts = state.drafts
        if ((drafts[roomId] || '') === text) return
        drafts = Object.assign({}, drafts)
        if (text) drafts[roomId] = text
        else delete drafts[roomId]
        set({ drafts: drafts })
      }

      /** 屋子没了（解散、被移出）就把那份草稿丢掉：房号是随机的，不会再回来。 */
      function livingDrafts(drafts, snapshot) {
        var ids = new Set(snapshot.rooms.map((room) => room.id))
        var kept = {}
        var dropped = false
        for (var key of Object.keys(drafts)) {
          if (ids.has(key)) kept[key] = drafts[key]
          else dropped = true
        }
        return dropped ? kept : drafts
      }

      /**
       * 未读涨了，得说清是「哪间屋子的哪句话」。
       *
       * 原先这里只看当前激活那间屋子的最后一句：消息其实是在别的屋子里来的，
       * 提醒就念着这间屋子的旧话；而这间屋子最后一句若不是 agent 说的，
       * 干脆一条提醒都没有 —— 你在 A 屋翻历史，B 屋的 agent 回了你，界面一声不响。
       * 还有一处更隐蔽：A 屋的未读刚被读掉、B 屋同时来一条，加起来的总数没变，
       * 提醒也就不来了。所以判据不能是「未读总数」，只能是「哪间屋子涨了」。
       */
      function pickNotice(next, prev) {
        var best = null
        for (var room of next.rooms) {
          var before = (prev.rooms || []).find((row) => row.id === room.id)
          var delta = (room.unread || 0) - (before ? before.unread || 0 : 0)
          if (delta <= 0) continue
          if (!best || delta > best.delta) best = { room: room, before: before, delta: delta }
        }
        if (!best) return null
        var all = best.room.messages || []
        var fresh = []
        if (best.before) {
          // 只认这一轮新来的：按 seq 跟上一份快照比，别把旧话再念一遍。
          var lastSeq = 0
          for (var old of best.before.messages || []) lastSeq = Math.max(lastSeq, old.seq || 0)
          fresh = all.filter((row) => (row.seq || 0) > lastSeq)
        } else if (all.length) {
          fresh = [all[all.length - 1]]
        }
        // agent 的回复优先；这一轮只有人说话，那就报人的那句 —— 那也是「有话说」。
        var message = fresh.find((row) => row.authorKind === 'bot') || fresh[0] || all[all.length - 1]
        if (!message) return null
        return { room: best.room, message: message }
      }

      function applySnapshot(snapshot) {
        var picked = state.snapshot && !state.floatOpen ? pickNotice(snapshot, state.snapshot) : null
        var notice = state.notice
        if (picked) {
          notice = {
            id: picked.message.id,
            name: picked.message.authorName,
            // 正文可能是空的那几条（占位、系统提示），不能让它把 toast 弄崩。
            text: typeof picked.message.text === 'string' ? picked.message.text : '',
            room: picked.room.name,
            roomId: picked.room.id,
            at: Date.now(),
          }
        }
        set({
          snapshot: snapshot,
          loading: false,
          error: '',
          notice: notice,
          drafts: livingDrafts(state.drafts, snapshot),
        })
      }

      async function refresh() {
        try {
          var snapshot = await rpc('snapshot', {})
          if (!stopped) applySnapshot(snapshot)
          return snapshot
        } catch (error) {
          set({ error: String((error && error.message) || error), loading: false })
          return null
        }
      }

      async function watchLoop() {
        if (watching || stopped) return
        watching = true
        while (!stopped) {
          var since = state.snapshot ? state.snapshot.revision : -1
          try {
            var snapshot = await rpc('watch', { since: since }, 60000)
            if (stopped) break
            applySnapshot(snapshot)
          } catch (error) {
            if (stopped) break
            // 长轮询断了就等一下再续上；401/disabled 这类不再重试。
            var code = error && error.code
            if (code === 'disabled' || code === 'connection_unavailable') break
            await new Promise((resolve) => setTimeout(resolve, 1500))
          }
        }
        watching = false
      }

      async function command(action, input) {
        set({ error: '' })
        try {
          var snapshot = await rpc('command', { action: action, input: input || {} })
          var pending = state.pending
          if (action === 'msg.send') {
            pending = pending.filter((row) => row.action !== 'msg.send')
          }
          set({ pending: pending })
          applySnapshot(snapshot)
          return snapshot
        } catch (error) {
          set({ error: String((error && error.message) || error), pending: [] })
          throw error
        }
      }

      function send(roomId, text, mentions) {
        var opKey = 'k_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
        var pending = state.pending.concat([
          { opKey: opKey, action: 'msg.send', roomId: roomId, text: text, at: new Date().toISOString() },
        ])
        set({ pending: pending })
        return command('msg.send', { roomId: roomId, text: text, mentions: mentions || [], opKey: opKey }).catch(() => {})
      }

      async function pageOlder(roomId, beforeSeq, limit) {
        return rpc('messages', { roomId: roomId, beforeSeq: beforeSeq, limit: limit || 100 })
      }

      /**
       * 点一下提醒：打开悬浮窗，并把屋子切到「这句话」所在的那间。
       * 提醒说的是 B 屋、点开却还停在 A 屋，人就得自己再翻一遍才找得到 ——
       * 提醒指哪就该到哪，这也是它唯一的用处。
       */
      function focusRoom(notice) {
        var snapshot = state.snapshot
        var active = snapshot ? snapshot.activeRoomId : null
        set({ floatOpen: true, notice: null })
        var roomId = notice && notice.roomId
        if (!roomId || roomId === active) return Promise.resolve(null)
        return command('room.activate', { roomId: roomId }).catch(() => null)
      }

      return {
        get: get,
        subscribe: subscribe,
        set: set,
        activeRoom: activeRoom,
        totalUnread: totalUnread,
        refresh: refresh,
        watchLoop: watchLoop,
        command: command,
        send: send,
        pageOlder: pageOlder,
        focusRoom: focusRoom,
        draftOf: draftOf,
        setDraft: setDraft,
        stop: function () {
          stopped = true
        },
      }
    }

    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.get, store.get)
    }

    /* -------------------------------------------------------------- 组件 */

    function NavIcon(props) {
      var snapshot = (props && props.store ? props.store.get().snapshot : null) || null
      var unread = snapshot ? snapshot.rooms.reduce((sum, room) => sum + (room.unread || 0), 0) : 0
      var size = props && typeof props.size === 'number' ? props.size : 18
      // 旁边已经有数字徽标的地方（悬浮胶囊、会话标题栏按钮）不要再叠一个：
      // 同一个未读数在一处显示两遍，看着像两个未读。
      var withBadge = !(props && props.badge === false)
      var color = props && props.active ? 'var(--dsw-alias-brand-primary,#4f7cff)' : 'currentColor'
      return h(
        'span',
        { style: { position: 'relative', display: 'inline-flex', width: '18px', height: '18px' } },
        h(
          'svg',
          { width: size, height: size, viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': 'true' },
          h('path', {
            d: 'M2.4 5.2c0-1 .8-1.8 1.8-1.8h9.6c1 0 1.8.8 1.8 1.8v5.3c0 1-.8 1.8-1.8 1.8H7.6L4.2 15v-2.7h0c-1 0-1.8-.8-1.8-1.8V5.2Z',
            stroke: color,
            strokeWidth: '1.5',
            strokeLinejoin: 'round',
          }),
          h('path', { d: 'M5.9 6.6h6.2M5.9 9.2h4', stroke: color, strokeWidth: '1.5', strokeLinecap: 'round' }),
        ),
        unread > 0 && withBadge ? h('span', { className: 'cr-nav-badge' }, unread > 99 ? '99+' : String(unread)) : null,
      )
    }

    // 宿主的鲸鱼标志：形状取自本机 DSH 应用图标的剪影，压成 96px 的 alpha 蒙版，
    // 颜色跟 currentColor，所以侧栏、胶囊、浮窗头、授权卡用同一份形状。
    function WhaleMark(props) {
      var size = props && typeof props.size === 'number' ? props.size : 16
      return h('span', {
        className: 'cr-whale',
        style: { width: size + 'px', height: size + 'px' },
        'aria-hidden': 'true',
      })
    }

    /**
     * 成员的头像就是他那只会换色的虎鲸。
     *
     * 为什么不再用首字母：一只屋里常有两三个首字母相同的人（「我」「Wendy」「王工」），
     * 字母认不出谁是谁；而虎鲸 + 颜色是「这条消息是谁说的」最省事的一眼判据 ——
     * 也是宿主自己的标识，比造一个字母圆片更像这个产品的界面。
     *
     * 颜色走内联 style 的 currentColor：底盘是同一色 14% 的淡底，鲸是本色，
     * 一深一浅两个人也有区别，但不会各自发亮成八种荧光。
     */
    function Avatar(props) {
      var member = props.member
      var hex = whaleOf(member)
      return h(
        'div',
        { className: 'cr-avatar', style: { color: hex }, title: member ? member.name : '' },
        // 尺寸交给 CSS（按头像那一圈的大小换算），这里不带内联宽高：
        // 成员列 24px、消息行 32px、浮窗 24px，同一个组件三处都合身。
        h('span', { className: 'cr-whale cr-whale-av', 'aria-hidden': 'true' }),
      )
    }

    /**
     * 挑颜色的那一排色块。
     *
     * 8 个 24px 的点击区里画 12px 的圆点：24px 是手指/触控板都点得准的下限，
     * 12px 是「八个挤在一行还不糊成一片」的上限。选中不用描边抢眼，只把圆点调实
     * 加一圈同色淡环 —— 描边在深色底上会被当成「禁用」。
     */
    function WhalePalette(props) {
      var tr = props.tr
      return h(
        'div',
        { className: 'cr-sw' + (props.className ? ' ' + props.className : ''), role: 'group', 'aria-label': tr('whale') },
        WHALE.map(function (entry) {
          var id = entry[0]
          var hex = entry[1]
          var on = props.value === id
          return h(
            'button',
            {
              key: id,
              type: 'button',
              className: 'cr-sw-dot',
              style: { color: hex },
              'aria-pressed': on ? 'true' : 'false',
              'aria-label': whaleName(tr, id),
              title: whaleName(tr, id),
              onClick: function () {
                props.onPick(id)
              },
            },
            h('span', { className: 'cr-sw-core' }),
          )
        }),
      )
    }

    function OriginChip(props) {
      var member = props.member
      var tr = props.tr
      var lan = member.origin && member.origin.kind === 'lan'
      // 本机是默认状态，不给它贴标签 —— 只有「从别的机器进来的」才需要一眼认出来。
      // 认机器比认 IP 有用：192.168.1.42 谁都记不住，「周荻的 MacBook」一眼就知道是谁。
      if (!lan) return null
      var who = member.origin && (member.origin.machine || member.origin.peer)
      var label = tr('lan') + (who ? ' · ' + who : '')
      // 成员列窄：只留「LAN」，完整机器名放 title；消息行有位置，照旧写全。
      return h(
        'span',
        { className: 'cr-chip cr-lan', title: label },
        props.compact && lan ? tr('lan') : label,
      )
    }

    /** 这台机器有没有「说不清 agent 为什么不在」的事要讲。 */
    function needsAttention(peer) {
      return peer.canAgents === false || !(peer.agents && peer.agents.length)
    }

    /** 一台 LAN 机器：机器名一行，下面一行说清它为什么没带 agent。 */
    function PeerRow(props) {
      var peer = props.peer
      var tr = props.tr
      return h(
        'div',
        { className: 'cr-peer', title: peer.address || peer.machine },
        h('div', { className: 'cr-peer-machine' }, peer.machine || peer.address || 'LAN'),
        peer.canAgents === false
          ? h('div', { className: 'cr-warn' }, tr('peerOld'))
          : h('div', { className: 'cr-peer-state' }, tr('peerNoneYet')),
      )
    }

    /** 邀请另一台机器：地址 + 房间码就是全部凭据，抄过去即可，不用账号。 */
    function InviteBar(props) {
      var room = props.room
      var lan = props.lan || {}
      var tr = props.tr
      var [copied, setCopied] = React.useState(false)
      /* 地址按「对方最可能连得上」排过序：真实网卡在前，WSL / Hyper-V 这类虚拟网卡在后，
       * 并带 virtual 标记。只显示一个地址会在装了 WSL2 的机器上递错地址 —— 抄过去一直超时。 */
      var cands = (lan.addresses || []).filter(function (row) {
        return row && row.address
      })
      var primary = cands[0]
      var others = cands.slice(1)
      var address = lan.serving
        ? (primary ? primary.address : '127.0.0.1') + ':' + lan.port
        : ''
      if (!lan.serving) {
        return h(
          'div',
          { className: 'cr-invite' },
          h('div', { className: 'cr-invite-note' }, tr('lanOff') + (lan.error ? '：' + lan.error : '')),
        )
      }
      var copy = function () {
        try {
          navigator.clipboard.writeText(address + ' ' + room.code).then(
            function () {
              setCopied(true)
              setTimeout(function () {
                setCopied(false)
              }, 1600)
            },
            function () {},
          )
        } catch (error) {
          /* 剪贴板不可用时不影响看地址 */
        }
      }
      return h(
        'div',
        { className: 'cr-invite' },
        h(
          'div',
          { className: 'cr-invite-row' },
          h('span', { className: 'cr-invite-label' }, tr('inviteAddress')),
          h('code', null, address),
          h('span', { className: 'cr-grow' }),
          h('button', { className: 'cr-btn cr-ghost', onClick: copy }, copied ? tr('copied') : tr('copy')),
        ),
        h(
          'div',
          { className: 'cr-invite-row' },
          h('span', { className: 'cr-invite-label' }, tr('code')),
          h('code', null, room.code),
          lan.peers && lan.peers.length
            ? h('span', { className: 'cr-chip cr-lan' }, lan.peers.length + ' ' + tr('lanPeers'))
            : null,
        ),
        h('div', { className: 'cr-invite-note' }, tr('inviteHint')),
        others.length
          ? h(
              'div',
              { className: 'cr-invite-note' },
              tr('inviteMore') +
                others
                  .map(function (row) {
                    return row.address + '（' + row.name + (row.virtual ? '，' + tr('virtualNic') : '') + '）'
                  })
                  .join(' · '),
            )
          : null,
        primary && primary.virtual ? h('div', { className: 'cr-warn' }, tr('inviteVirtualOnly')) : null,
      )
    }

    function MessageRow(props) {
      var message = props.message
      var members = props.members
      var tr = props.tr
      var mine = message.authorId === props.selfId
      var author = members.find((member) => member.id === message.authorId) || {
        name: message.authorName,
        kind: message.authorKind,
        origin: message.origin,
      }
      // 「这一轮没执行」是房间的一件事，不是谁说的话：不带头像、不署名、不占气泡。
      // 它必须能看见（否则用户以为 agent 没反应），但不能长得像一条失败消息。
      if (message.status === 'notice') {
        return h('div', { className: 'cr-notice' }, renderInline(message.text, members, 'n' + message.seq))
      }
      return h(
        'div',
        {
          className:
            'cr-msg' +
            (mine ? ' cr-mine' : '') +
            (props.cont ? ' cr-cont' : '') +
            (message.status === 'error' ? ' cr-error' : '') +
            // 浮窗里同一个组件要再挂一个自己的类名（缩字号、重试按钮换成胶囊），
            // 样式分叉只走这个后缀，行结构本身不复制一份。
            (props.className ? ' ' + props.className : ''),
          // 把这条消息作者的颜色挂成 CSS 变量，气泡边框、名字与头像再用它上色：
          // 同一间屋里「谁说的」一眼可辨，连续同一人则是同一条色带。
          style: { '--cr-author': whaleOf(author) },
        },
        h(Avatar, { member: author, name: message.authorName }),
        h(
          'div',
          { className: 'cr-msg-body' },
          h(
            'div',
            { className: 'cr-msg-meta' },
            // 自己的消息加「（我）」后缀；默认名字本来就叫「我」时不重复成「我（我）」
            h(
              'span',
              { className: 'cr-msg-name' },
              message.authorName + (mine && message.authorName !== tr('you') ? '（' + tr('you') + '）' : ''),
            ),
            h(OriginChip, { member: author, tr: tr }),
            h('span', { className: 'cr-msg-time' }, clock(message.at)),
          ),
          h('div', { className: 'cr-msg-text' }, renderInline(message.text, members, 'm' + message.seq)),
          // 失败那一行给一次「重试」的机会：宿主只重跑这一个 agent，不惊动屋里其他人。
          // 光有占位消息、没有入口的话，用户只能靠再 @ 一遍来重试。
          message.status === 'error' && props.onRetry
            ? h(
                'div',
                { className: 'cr-msg-actions' },
                h(
                  'button',
                  {
                    className: 'cr-link-btn',
                    disabled: Boolean(props.busy || props.retrying),
                    // 这一轮还没收尾时宿主会回 room_busy：先说清楚，别让人点了没反应。
                    title: props.busy ? tr('busy') : null,
                    onClick: () => props.onRetry(message),
                  },
                  props.retrying ? tr('retry') + '…' : tr('retry'),
                ),
              )
            : null,
        ),
      )
    }

    function RoomList(props) {
      var snapshot = props.snapshot
      var store = props.store
      var tr = props.tr
      var creating = props.creating
      var formName = props.formName
      var formTopic = props.formTopic
      // 建屋要自己挑一档颜色：这间屋还不存在「我以前在这屋是什么颜色」，
      // 没有可继承的东西 —— 不挑就建，等于又回到「人人一只白鲸」。
      var formColor = props.formColor
      // 旧宿主不认「每间屋一个座位」：这一排色块画出来也只会改了全局色，不如不画。
      var canPalette = props.canPalette
      return h(
        'div',
        { className: 'cr-col' },
        h(
          'div',
          { className: 'cr-col-head' },
          h('span', { className: 'cr-col-title' }, tr('title')),
          h('span', { className: 'cr-count' }, String(snapshot.rooms.length)),
          h('span', { className: 'cr-grow' }),
          h(
            'button',
            { className: 'cr-btn cr-ghost', onClick: props.onToggleCreate, title: tr('newRoom') },
            creating ? tr('cancel') : '+ ' + tr('newRoom'),
          ),
          // 收起这一列：放在最右侧、带边框，和旁边的按钮同一套样式。
          // 状态存进 localStorage，下次打开面板还是收着的（见 RoomsPanel）。
          h(
            'button',
            {
              className: 'cr-btn cr-nav-toggle',
              title: tr('collapseRooms'),
              'aria-label': tr('collapseRooms'),
              onClick: props.onCollapse,
            },
            h('span', { className: 'cr-chevron', 'aria-hidden': 'true' }, '«'),
          ),
        ),
        creating
          ? h(
              'div',
              { className: 'cr-form cr-create-form' },
              h('input', {
                className: 'cr-field',
                placeholder: tr('roomName'),
                value: formName,
                autoFocus: true,
                onChange: (event) => props.onFormName(event.target.value),
                onKeyDown: (event) => {
                  if (imePicking(event)) return
                  if (event.key === 'Enter') props.onCreate()
                },
              }),
              h('input', {
                className: 'cr-field',
                placeholder: tr('roomTopic'),
                value: formTopic,
                onChange: (event) => props.onFormTopic(event.target.value),
                onKeyDown: (event) => {
                  if (imePicking(event)) return
                  if (event.key === 'Enter') props.onCreate()
                },
              }),
              canPalette
                ? h(
                    'div',
                    { className: 'cr-form-row' },
                    h('span', { className: 'cr-form-label' }, tr('whale')),
                    h(WhalePalette, { tr: tr, value: formColor, onPick: props.onFormColor }),
                  )
                : null,
              // 没挑颜色时把「为什么按钮按不下去」写出来，别让人对着一个灰按钮猜。
              canPalette && !formColor ? h('div', { className: 'cr-hint cr-flat' }, tr('whaleCreate')) : null,
              h(
                'div',
                { style: { display: 'flex', gap: '8px' } },
                h(
                  'button',
                  { className: 'cr-btn cr-primary', disabled: !formName.trim() || (canPalette && !formColor), onClick: props.onCreate },
                  tr('create'),
                ),
                h('button', { className: 'cr-btn cr-ghost', onClick: props.onToggleCreate }, tr('cancel')),
              ),
            )
          : null,
        h(
          'div',
          { className: 'cr-rooms' },
          snapshot.rooms.length === 0
            ? h('div', { className: 'cr-empty', style: { height: 'auto', paddingTop: '24px' } }, h('div', null, tr('empty')))
            : snapshot.rooms.map((room) =>
                h(
                  'div',
                  {
                    key: room.id,
                    className: 'cr-room' + (room.id === snapshot.activeRoomId ? ' cr-active' : ''),
                    onClick: () => props.onActivate(room.id),
                  },
                  h('div', { className: 'cr-room-avatar' }, initial(room.name)),
                  h(
                    'div',
                    { className: 'cr-room-body' },
                    h(
                      'div',
                      { className: 'cr-room-top' },
                      h('span', { className: 'cr-room-name' }, room.name),
                      room.remote ? h('span', { className: 'cr-chip cr-lan' }, tr('remoteTag')) : null,
                      // 名字撑满剩余宽度、时间固定贴右：中间不再垫一个 grow，
                      // 否则在 1280 宽度下标题与时间会各占一半，长房间名反而叠到时间上。
                      // 未读在那儿就显示数字；读完了显示最近一条的时间 —— 一行里只放一个「右对齐的东西」。
                      room.unread > 0
                        ? h('span', { className: 'cr-badge' }, room.unread > 99 ? '99+' : String(room.unread))
                        : room.messages.length
                          ? h('span', { className: 'cr-room-time' }, clock(room.messages[room.messages.length - 1].at))
                          : null,
                    ),
                    h(
                      'span',
                      { className: 'cr-room-preview' },
                      (room.messages.length ? room.messages[room.messages.length - 1].authorName + '：' + room.messages[room.messages.length - 1].text : tr('emptyPreview')) || '',
                    ),
                  ),
                ),
              ),
        ),
        // LAN 入口放左栏底部：不抢「新建房间」的位置，也不用多一个图标。
        h(
          'div',
          { className: 'cr-col-foot' },
          // 「我的 agent」在名字上面：进别人的屋子之前，先看清「我带谁一起进去」。
          // 加入之后再建也走这里 —— 建完立刻报给宿主，屋里马上多一个人。
          h(
            'div',
            { className: 'cr-name-row' },
            h('span', { className: 'cr-name-label', title: tr('myAgentsHint') }, tr('myAgents')),
            h('span', { className: 'cr-grow' }),
            h(
              'button',
              { className: 'cr-link-btn', onClick: props.onToggleMy },
              props.myForm ? tr('cancel') : '+ ' + tr('agentNew'),
            ),
          ),
          props.bots.length
            ? h(
                'div',
                { className: 'cr-chips' },
                props.bots.map((bot) =>
                  // 删掉 agent 是不可逆的：第一次点只问一句，同一个位置答完才真的删。
                  props.confirmBot === bot.id
                    ? h(
                        'span',
                        { key: bot.id, className: 'cr-chip cr-agent-chip cr-agent-ask' },
                        h('span', { className: 'cr-agent-name' }, tr('removeAgentAsk')),
                        h(
                          'button',
                          {
                            className: 'cr-agent-yes',
                            'aria-label': tr('removeAgent'),
                            title: tr('removeAgent'),
                            onClick: () => props.onRemoveMy(bot.id),
                          },
                          tr('removeAgentYes'),
                        ),
                        h(
                          'button',
                          {
                            className: 'cr-agent-x',
                            'aria-label': tr('cancel'),
                            title: tr('cancel'),
                            onClick: props.onCancelRemove,
                          },
                          '×',
                        ),
                      )
                    : h(
                        'span',
                        { key: bot.id, className: 'cr-chip cr-agent-chip', title: bot.role || '' },
                        h('span', { className: 'cr-agent-name' }, bot.name),
                        h(
                          'button',
                          {
                            className: 'cr-agent-x',
                            'aria-label': tr('removeAgent'),
                            title: tr('removeAgent'),
                            onClick: () => props.onAskRemove(bot.id),
                          },
                          '×',
                        ),
                      ),
                ),
              )
            : h('div', { className: 'cr-hint cr-flat' }, tr('myAgentsNone')),
          props.myForm
            ? h(
                'div',
                { className: 'cr-my-form' },
                h('input', {
                  className: 'cr-field',
                  placeholder: tr('agentName'),
                  value: props.myForm.name,
                  autoFocus: true,
                  'aria-label': tr('agentName'),
                  onChange: (event) => props.onMyDraft({ name: event.target.value }),
                  onKeyDown: (event) => {
                    if (imePicking(event)) return
                    if (event.key === 'Enter' && props.myForm.name.trim()) props.onMySave()
                    if (event.key === 'Escape') props.onMyCancel()
                  },
                }),
                h('input', {
                  className: 'cr-field',
                  placeholder: tr('agentRole'),
                  value: props.myForm.role,
                  'aria-label': tr('agentRole'),
                  onChange: (event) => props.onMyDraft({ role: event.target.value }),
                  onKeyDown: (event) => {
                    if (imePicking(event)) return
                    if (event.key === 'Enter' && props.myForm.name.trim()) props.onMySave()
                    if (event.key === 'Escape') props.onMyCancel()
                  },
                }),
                h('input', {
                  className: 'cr-field',
                  placeholder: tr('agentCwd'),
                  value: props.myForm.cwd || '',
                  'aria-label': tr('agentCwd'),
                  spellCheck: false,
                  onChange: (event) => props.onMyDraft({ cwd: event.target.value }),
                  onKeyDown: (event) => {
                    if (imePicking(event)) return
                    if (event.key === 'Enter' && props.myForm.name.trim()) props.onMySave()
                    if (event.key === 'Escape') props.onMyCancel()
                  },
                }),
                // 颜色只在「这间屋归本机」时才有意义：加进镜像房间的 agent 由宿主安排座位，
                // 这里画一排点不动的色块，只会让人以为颜色没生效。
                props.localRoomId && props.canPalette
                  ? h(
                      'div',
                      { className: 'cr-form-row' },
                      h(
                        'span',
                        { className: 'cr-form-label' },
                        props.myForm.pickedColor ? tr('whale') : tr('whale') + ' · ' + tr('whaleAuto'),
                      ),
                      h(WhalePalette, {
                        tr: tr,
                        value: props.myForm.color || null,
                        onPick: (color) => props.onMyDraft({ color: color, pickedColor: true }),
                      }),
                    )
                  : null,
                h(
                  'div',
                  { style: { display: 'flex', gap: '8px' } },
                  h(
                    'button',
                    { className: 'cr-btn cr-primary', disabled: !props.myForm.name.trim(), onClick: props.onMySave },
                    tr('save'),
                  ),
                  h('button', { className: 'cr-btn cr-ghost', onClick: props.onMyCancel }, tr('cancel')),
                ),
              )
            : null,
          // 名字写在加入口上面：进别人的屋子之前先让对面知道你是谁，
          // 否则第二台机器上的人只会叫「GUEST-A」这种机器名。
          h(
            'div',
            { className: 'cr-name-row' },
            h('span', { className: 'cr-name-label', title: tr('settingsSelf') }, tr('settingsSelf')),
            h('input', {
              className: 'cr-field',
              // null 才是「还没动过这个框」，显示当前名字；空串是「用户刚把它删干净」，
              // 必须如实显示成空 —— 否则删掉最后一个字时旧名字当场长回来，人再打字就是
              // 「旧名字 + 新名字」，看起来像「这个名字里必须带一个某字」。
              value: props.nameDraft ?? props.selfName,
              'aria-label': tr('settingsSelf'),
              // 点进来就全选：改名通常是「换一个」，不是「在旧名字后面接着打」。
              onFocus: (event) => event.target.select(),
              onChange: (event) => props.onNameDraft(event.target.value),
              onBlur: props.onCommitName,
              onKeyDown: (event) => {
                if (imePicking(event)) return
                if (event.key === 'Enter') props.onCommitName()
              },
            }),
          ),
          // 我的虎鲸颜色。放在名字下面而不是塞进成员列：这是「我在这间屋里的座位」，
          // 和改名是同一个位置的两个动作。宿主还是旧版本时整块不画（它没有 self.color）——
          // 画出来点不动，比不画更像坏了。
          // 加入表单展开时不画：那块表单里也有一个「虎鲸」，两排挨着会让人以为要挑两次；
          // 而且这时候我改的是将要离开的这间屋，不是要进的那间。
          props.canColor && !props.joinOpen
            ? h(
                'div',
                { className: 'cr-color-row' },
                h('span', { className: 'cr-name-label' }, tr('whale')),
                h(WhalePalette, {
                  tr: tr,
                  value: props.selfColor,
                  onPick: props.onSelfColor,
                }),
              )
            : null,
          props.joinOpen
            ? h(
                'div',
                { className: 'cr-join-form', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                h('input', {
                  className: 'cr-field',
                  placeholder: tr('joinAddress'),
                  value: props.joinHost,
                  autoFocus: true,
                  onChange: (event) => props.onJoinHost(event.target.value),
                }),
                h('input', {
                  className: 'cr-field',
                  placeholder: tr('joinCode'),
                  value: props.joinCode,
                  style: { textTransform: 'uppercase' },
                  onChange: (event) => props.onJoinCode(event.target.value),
                  onKeyDown: (event) => {
                    if (imePicking(event)) return
                    if (event.key === 'Enter') props.onJoin()
                  },
                }),
                // 进屋要自己挑一档颜色：对面屋里的座位是那边的，不挑的话会被安排成
                // 「空着的那一档」，换一间屋又变成另一种颜色 —— 挑一次，这间屋就记住了。
                props.canPalette
                  ? h(
                      'div',
                      { className: 'cr-form-row' },
                      h('span', { className: 'cr-form-label' }, tr('whale')),
                      h(WhalePalette, { tr: tr, value: props.joinColor, onPick: props.onJoinColor }),
                    )
                  : null,
                props.canPalette && !props.joinColor
                  ? h('div', { className: 'cr-hint cr-flat' }, tr('whaleJoin'))
                  : null,
                // 加入那一刻只能带走「本机已经有的」agent —— 这句是唯一提前讲清楚的地方。
                h(
                  'div',
                  { className: 'cr-hint cr-flat' },
                  props.bots.length
                    ? tr('bringAgents') + props.bots.map((bot) => bot.name).join('、')
                    : tr('bringNone'),
                ),
                h(
                  'div',
                  { style: { display: 'flex', gap: '8px' } },
                  h(
                    'button',
                    {
                      className: 'cr-btn cr-primary',
                      disabled: !(props.joinHost.trim() && props.joinCode.trim() && (!props.canPalette || props.joinColor)),
                      onClick: props.onJoin,
                    },
                    tr('join'),
                  ),
                  h('button', { className: 'cr-btn cr-ghost', onClick: props.onToggleJoin }, tr('cancel')),
                ),
              )
            : h(
                'button',
                { className: 'cr-link-btn', onClick: props.onToggleJoin },
                '+ ' + tr('joinLan'),
              ),
        ),
      )
    }

    /* 光标前那段「@片段」：@ 前面必须是开头或空白，中间不能有空格。
     * 提到名字这件事以宿主认得的那段正文为准，这里只负责把候选摆到人眼前。 */
    function mentionAt(text, caret) {
      var index = Math.min(caret, text.length) - 1
      while (index >= 0) {
        var ch = text.charAt(index)
        if (ch === '@') {
          var before = index === 0 ? '' : text.charAt(index - 1)
          if (before === '' || /\s/.test(before)) return { at: index, query: text.slice(index + 1, caret) }
          return null
        }
        if (/\s/.test(ch)) return null
        index -= 1
      }
      return null
    }

    /* 候选排序：名字开头对上的在前，中间对上的在后。一边打一边筛，
     * 人不用记得 agent 叫什么全名 —— 打「@退」就能挑到「退货 agent」。 */
    function matchMembers(bots, query) {
      if (!query) return bots
      var needle = query.toLowerCase()
      var starts = []
      var loose = []
      for (var i = 0; i < bots.length; i += 1) {
        var name = String(bots[i].name || '').toLowerCase()
        if (name.indexOf(needle) === 0) starts.push(bots[i])
        else if (name.indexOf(needle) > 0) loose.push(bots[i])
      }
      return starts.concat(loose)
    }

    function Composer(props) {
      var room = props.room
      var tr = props.tr
      var members = room.members
      var canMention = members.filter((member) => member.kind === 'bot')
      // 宿主解散了这间屋子：镜像还在（能看历史），但已经没有可以写进去的地方。
      var gone = Boolean(room.remote && room.remote.lost)
      // 底栏那一行：正在说，或者正等着本机点授权。两种等待都得说出来。
      var working = activityLine(room, tr)
      // 浮窗里用同一套输入（含 @ 候选、选词回车、按房号存的草稿），只省掉底部那一排门。
      // 两处各写一份输入框，@ 的行为迟早再分叉一次 —— 上次两个 @ 就是这么来的。
      var compact = Boolean(props.compact)
      var areaRef = React.useRef(null)
      var [caret, setCaret] = React.useState(0)
      var [active, setActive] = React.useState(0)
      // 按过 Esc 就先收起这一次候选；换一段 @片段 再重新打开。
      var [dismissed, setDismissed] = React.useState(false)
      var hit = gone ? null : mentionAt(props.draft, caret)
      var items = hit && !dismissed ? matchMembers(canMention, hit.query) : []
      var syncCaret = () => {
        var el = areaRef.current
        if (el) setCaret(el.selectionStart ?? 0)
      }
      var dropAt = (next) => {
        // React 下一帧才把 value 写进 textarea：光标要在那之后再放，否则被这次的 value 冲掉。
        window.requestAnimationFrame(() => {
          var el = areaRef.current
          if (!el) return
          el.focus()
          el.setSelectionRange(next, next)
          setCaret(next)
        })
      }
      /* 选中一个候选：把光标前那段 @片段 整段换成「@名字 」。
       * 以前是往草稿末尾拼「@名字 」，人已经打过的那个 @ 就留在前面，
       * 发出去成了「@ @名字」—— 两个 @ 是这么来的。 */
      var pick = (member) => {
        var at = hit ? hit.at : caret
        var end = hit ? caret : caret
        var label = '@' + member.name + ' '
        setDismissed(false)
        setActive(0)
        props.onDraft(props.draft.slice(0, at) + label + props.draft.slice(end))
        dropAt(at + label.length)
      }
      /* 「@」按钮：往光标处插一个 @，候选由它自己开出来。 */
      var insertAt = (text) => {
        var at = Math.min(caret, props.draft.length)
        setDismissed(false)
        setActive(0)
        props.onDraft(props.draft.slice(0, at) + text + props.draft.slice(at))
        dropAt(at + text.length)
      }
      return h(
        'div',
        { className: 'cr-composer' + (compact ? ' cr-composer-compact' : ''), style: { position: 'relative' } },
        gone || !hit || dismissed
          ? null
          : h(
              'div',
              { className: 'cr-mention-pop' },
              canMention.length === 0
                ? h('div', { className: 'cr-pop-row', style: { cursor: 'default', opacity: 0.6 } }, '屋里还没有 agent')
                : items.length === 0
                  ? h('div', { className: 'cr-pop-row', style: { cursor: 'default', opacity: 0.6 } }, '没有匹配的 agent')
                  : items.map((member, index) =>
                      h(
                        'button',
                        {
                          key: member.id,
                          className: 'cr-pop-row' + (index === Math.min(active, items.length - 1) ? ' cr-active' : ''),
                          // 按住鼠标时别把焦点从输入框抢走：抢走之后光标位置就丢了。
                          onMouseDown: (event) => event.preventDefault(),
                          onClick: () => pick(member),
                        },
                        h(Avatar, { member: member, name: member.name }),
                        h('span', { className: 'cr-pop-name' }, member.name),
                      ),
                    ),
            ),
        // 身份行：多人多 agent 的屋里，「这句是以谁的身份发出去的」不是装饰。
        // 浮窗里也留着，只是压到 11px —— 内容不该因为窗口小就少一块。
        gone
          ? null
          : h(
              'div',
              { className: 'cr-composer-identity' },
              h('span', null, tr('speakingAs') + ' '),
              h('b', null, props.selfName || tr('you')),
              tr('speakingAsEnd') ? h('span', null, ' ' + tr('speakingAsEnd')) : null,
            ),
        h(
          'div',
          { className: 'cr-input-row' },
          h(
            'div',
            { className: 'cr-input-shell' },
            h('textarea', {
              // 浮窗的截图/输入法检查按这个类名找输入框：尺寸由 .cr-composer-compact 压。
              className: 'cr-textarea' + (compact ? ' cr-float-input' : ''),
              placeholder: gone ? tr('roomGone') : compact ? tr('floatHint') : tr('sendHint'),
              value: props.draft,
              rows: 1,
              ref: areaRef,
              disabled: gone,
              onChange: (event) => {
                var value = event.target.value
                var pos = event.target.selectionStart ?? value.length
                props.onDraft(value)
                // 换了一段 @片段（或离开 @）就把「按过 Esc」忘掉，重新给候选。
                var next = mentionAt(value, pos)
                if (!hit || !next || next.at !== hit.at) setDismissed(false)
                setActive(0)
                setCaret(pos)
              },
              onSelect: syncCaret,
              onClick: syncCaret,
              onKeyDown: (event) => {
                if (imePicking(event)) return
                // 候选开着的时候，上下选、回车挑、Esc 收 —— 回车不能把「@账」当一句话发出去。
                if (items.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                  event.preventDefault()
                  setActive((current) => {
                    var step = event.key === 'ArrowDown' ? 1 : -1
                    var next = current + step
                    if (next < 0) return items.length - 1
                    if (next >= items.length) return 0
                    return next
                  })
                  return
                }
                if (items.length && event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  pick(items[Math.min(active, items.length - 1)])
                  return
                }
                if (items.length && event.key === 'Escape') {
                  event.preventDefault()
                  setDismissed(true)
                  return
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  props.onSend()
                }
              },
            }),
            h(
              'button',
              {
                className: 'cr-btn cr-ghost cr-mention-btn',
                title: tr('mention'),
                'aria-label': tr('mention'),
                disabled: gone,
                onClick: () => insertAt('@'),
              },
              '@',
            ),
          ),
          h(
            'button',
            {
              className: 'cr-btn cr-primary cr-send',
              title: tr('send'),
              disabled: gone || !props.draft.trim(),
              onClick: props.onSend,
            },
            tr('send'),
          ),
        ),
        // 底部那一排（人数、正在发言、全员说一轮）是面板才有的门：浮窗里没有轮次按钮，
        // 人数已经挪到标题栏第二行 —— 同一件事不写两遍。
        compact
          ? null
          : h(
              'div',
              { className: 'cr-composer-foot' },
              gone
                ? null
                : working
                  ? h('span', null, working)
                  : h(
                      'span',
                      null,
                      room.members.length + ' ' + tr('people') + ' · ' + lanCount(members) + ' ' + tr('lan'),
                    ),
              h('span', { className: 'cr-grow' }),
              room.remote
                ? gone
                  ? null
                  : h('span', { className: 'cr-chip' }, tr('hosted'))
                : h(
                    'button',
                    {
                      className: 'cr-btn cr-ghost',
                      // 等着本机授权时也该能停：那一轮真的挂在那里等人点。
                      onClick: props.onRound,
                    },
                    working ? tr('stop') : tr('round'),
                  ),
            ),
      )
    }

    function MembersColumn(props) {
      var room = props.room
      var tr = props.tr
      var people = room.members.filter((member) => member.kind === 'human')
      var agents = room.members.filter((member) => member.kind === 'bot')
      var form = props.agentForm

      // 新建与编辑共用一个表单：字段一样（名字 + 职责），提交的动作按有没有 botId 分叉。
      var formNode = () =>
        h(
          'div',
          { className: 'cr-agent-form' },
          h('input', {
            className: 'cr-field',
            placeholder: tr('agentName'),
            value: form.name,
            autoFocus: true,
            'aria-label': tr('agentName'),
            onChange: (event) => props.onAgentDraft({ name: event.target.value }),
            onKeyDown: (event) => {
              if (imePicking(event)) return
              if (event.key === 'Enter' && form.name.trim()) props.onAgentSave()
              if (event.key === 'Escape') props.onAgentCancel()
            },
          }),
          h('input', {
            className: 'cr-field',
            placeholder: tr('agentRole'),
            value: form.role,
            'aria-label': tr('agentRole'),
            onChange: (event) => props.onAgentDraft({ role: event.target.value }),
            onKeyDown: (event) => {
              if (imePicking(event)) return
              if (event.key === 'Enter' && form.name.trim()) props.onAgentSave()
              if (event.key === 'Escape') props.onAgentCancel()
            },
          }),
          h('input', {
            className: 'cr-field',
            placeholder: tr('agentCwd'),
            value: form.cwd || '',
            'aria-label': tr('agentCwd'),
            spellCheck: false,
            onChange: (event) => props.onAgentDraft({ cwd: event.target.value }),
            onKeyDown: (event) => {
              if (imePicking(event)) return
              if (event.key === 'Enter' && form.name.trim()) props.onAgentSave()
              if (event.key === 'Escape') props.onAgentCancel()
            },
          }),
          props.canPalette
            ? h(
                'div',
                { className: 'cr-form-row' },
                h(
                  'span',
                  { className: 'cr-form-label' },
                  // 改一只已经坐着的 agent：先把它在这间屋里的那一档显示出来（是真的）。
                  // 新建时没挑就写「自动分配」：宿主会给一档屋里空着的。
                  form.memberId || form.pickedColor ? tr('whale') : tr('whale') + ' · ' + tr('whaleAuto'),
                ),
                h(WhalePalette, {
                  tr: tr,
                  // 值就是这间屋里的那一档；新建时没挑是空，宿主来安排。
                  value: form.color || null,
                  onPick: (color) => props.onAgentDraft({ color: color, pickedColor: true }),
                }),
              )
            : null,
          h(
            'div',
            { style: { display: 'flex', gap: '8px' } },
            h(
              'button',
              { className: 'cr-btn cr-primary', disabled: !form.name.trim(), onClick: props.onAgentSave },
              tr('save'),
            ),
            h('button', { className: 'cr-btn cr-ghost', onClick: props.onAgentCancel }, tr('cancel')),
          ),
        )

      var row = (member) => {
        // 正在改的那一行原地换成表单，不弹窗：改的就是这行里的名字和职责。
        if (form && form.botId && member.botId && member.botId === form.botId) {
          return h('div', { key: member.id, className: 'cr-member cr-member-editing' }, formNode())
        }
        // 别人的 agent 在别人那台机器上，只能在他那边改。
        var editable =
          !props.remote && member.botId && (!member.origin || member.origin.kind !== 'lan')
        // 第二行只放有信息量的东西：agent 放职责，跨机器的人放他那台机器的名字。
        // 本机的人没有第二行 —— 一行名字就够了。
        var subtitle =
          member.role ||
          (member.kind === 'bot'
            ? tr('agentKind')
            : member.origin && member.origin.kind === 'lan'
              ? member.origin.machine || member.origin.peer || ''
              : '')
        return h(
          'div',
          { key: member.id, className: 'cr-member' },
          h(Avatar, { member: member, name: member.name }),
          h(
            'div',
            { style: { minWidth: 0, flex: 1 } },
            h('div', { className: 'cr-member-name' }, member.name),
            subtitle ? h('div', { className: 'cr-member-role' }, subtitle) : null,
          ),
          h(OriginChip, { member: member, tr: tr, compact: true }),
          editable
            ? h(
                'button',
                {
                  className: 'cr-icon-btn cr-edit-btn',
                  title: tr('agentEdit'),
                  onClick: () => props.onEditAgent(member),
                },
                tr('edit'),
              )
            : null,
          member.id === props.selfId || props.remote
            ? null
            : h(
                'button',
                { className: 'cr-icon-btn', title: tr('remove'), onClick: () => props.onRemove(member.id) },
                '×',
              ),
        )
      }
      return h(
        'div',
        { className: 'cr-col cr-col-members' },
        h(
          'div',
          { className: 'cr-col-head' },
          h('span', { className: 'cr-col-title' }, tr('members')),
          h('span', { className: 'cr-count' }, String(room.members.length)),
        ),
        h(
          'div',
          { className: 'cr-members' },
          h('div', { className: 'cr-group-label' }, tr('people')),
          people.map(row),
          h('div', { className: 'cr-group-label' }, tr('agents')),
          agents.length ? agents.map(row) : h('div', { className: 'cr-member', style: { opacity: 0.6 } }, '还没有 agent'),
          props.remote
            ? null
            : form && !form.botId
              ? formNode()
              : h(
                  'button',
                  { className: 'cr-btn cr-ghost', style: { margin: '8px 2px 0' }, onClick: props.onAddAgent },
                  '+ ' + tr('addAgent'),
                ),
          props.pickingAgent && !form
            ? h(
                'div',
                { className: 'cr-mention-pop', style: { position: 'static', marginTop: '8px' } },
                props.directory.map((bot) =>
                  h(
                    'button',
                    { key: bot.id, className: 'cr-pop-row', onClick: () => props.onPickAgent(bot.id) },
                    bot.name,
                  ),
                ),
                h(
                  'button',
                  { className: 'cr-pop-row', style: { opacity: 0.75 }, onClick: props.onNewAgent },
                  '+ ' + tr('agentNew'),
                ),
              )
            : null,
          /* 只在**有话要说**的机器上出现：旧版本报不了名单、或者那台还没建 agent。
           * 已经带着 agent 进来的机器不必再列一遍 —— 它的 agent 就在上面成员列里。 */
          props.peers && props.peers.filter(needsAttention).length
            ? h(
                'div',
                { className: 'cr-machines' },
                props.peers.filter(needsAttention).map((peer) => h(PeerRow, { key: peer.id, peer: peer, tr: tr })),
              )
            : null,
        ),
        props.rulesOpen && !props.remote
          ? h(
              'div',
              { className: 'cr-rules' },
              h(
                'label',
                { className: 'cr-check' },
                h('input', {
                  type: 'checkbox',
                  checked: room.rules.mention,
                  onChange: (event) => props.onRules({ mention: event.target.checked }),
                }),
                h('span', null, tr('ruleMention')),
              ),
              h(
                'label',
                { className: 'cr-check' },
                h('input', {
                  type: 'checkbox',
                  checked: room.rules.roundRobin,
                  onChange: (event) => props.onRules({ roundRobin: event.target.checked }),
                }),
                h('span', null, tr('ruleRound')),
              ),
              h(
                'label',
                { className: 'cr-check', style: { flexWrap: 'wrap' } },
                h('span', null, tr('ruleChair')),
                h(
                  'select',
                  {
                    className: 'cr-field',
                    style: { width: 'auto', flex: 1 },
                    value: room.rules.chairId || '',
                    onChange: (event) => props.onRules({ chairId: event.target.value || null }),
                  },
                  h('option', { value: '' }, tr('chairNone')),
                  agents.map((member) => h('option', { key: member.id, value: member.id }, member.name)),
                ),
              ),
              h(
                'label',
                { className: 'cr-check', style: { flexWrap: 'nowrap' } },
                h('span', { style: { whiteSpace: 'nowrap' } }, tr('maxSpeakers')),
                h('input', {
                  className: 'cr-field',
                  style: { width: '48px', flex: '0 0 48px' },
                  type: 'number',
                  min: 1,
                  max: 8,
                  value: room.rules.maxSpeakers,
                  onChange: (event) => props.onRules({ maxSpeakers: Number(event.target.value) }),
                }),
                h('span', { style: { whiteSpace: 'nowrap' } }, tr('speakersUnit')),
              ),
              h(
                'label',
                { className: 'cr-check', style: { flexWrap: 'nowrap' } },
                h('span', { style: { whiteSpace: 'nowrap' } }, tr('maxAutoRounds')),
                h('input', {
                  className: 'cr-field',
                  style: { width: '48px', flex: '0 0 48px' },
                  type: 'number',
                  min: 1,
                  max: 10,
                  value: room.rules.maxAutoRounds,
                  onChange: (event) => props.onRules({ maxAutoRounds: Number(event.target.value) }),
                }),
                h('span', { style: { whiteSpace: 'nowrap' } }, tr('roundsUnit')),
              ),
              props.confirmDissolve
                ? h(
                    'div',
                    { className: 'cr-confirm' },
                    h('div', { className: 'cr-confirm-text' }, tr('dissolveAsk')),
                    h(
                      'div',
                      { className: 'cr-confirm-row' },
                      h('button', { className: 'cr-btn cr-danger', onClick: props.onDissolve }, tr('dissolveYes')),
                      h('button', { className: 'cr-btn cr-ghost', onClick: props.onCancelDissolve }, tr('cancel')),
                    ),
                  )
                : h(
                    'div',
                    { style: { display: 'flex', gap: '8px', marginTop: '4px' } },
                    h('button', { className: 'cr-btn cr-danger', onClick: props.onAskDissolve }, tr('dissolve')),
                  ),
            )
          : null,
        /* 本机授权：只决定「别的机器派过来的回合要不要执行」，所以放在这儿而不是「规则」里 ——
         * 规则是这间屋子的，这个是你这台机器的。加入方也要能改：它才是被要求执行的那一边。
         * 宿主没这个能力（旧版本）时整块不画，见 RoomsPanel 里那段。 */
        props.auth
          ? h(
              'div',
              { className: 'cr-auth' },
              h(
                'div',
                { className: 'cr-auth-head' },
                h('span', null, tr('authTitle')),
                h('span', { className: 'cr-grow' }),
                h('span', { className: 'cr-auth-scope' }, tr('authScope')),
              ),
              h(
                'div',
                { className: 'cr-auth-seg', role: 'group', 'aria-label': tr('authTitle') },
                AUTH_LEVELS.map((level) =>
                  h(
                    'button',
                    {
                      key: level.id,
                      className: 'cr-auth-btn' + ((props.auth && props.auth.level) === level.id ? ' cr-on' : ''),
                      title: tr(level.note),
                      'aria-pressed': (props.auth && props.auth.level) === level.id,
                      onClick: () => props.onAuth(level.id),
                    },
                    tr(level.label),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'cr-auth-note' },
                tr((AUTH_LEVELS.find((row) => row.id === (props.auth && props.auth.level)) || AUTH_LEVELS[0]).note),
              ),
            )
          : null,
        props.remote
          ? h(
              'div',
              { className: 'cr-col-foot' },
              room.remote && room.remote.lost
                ? h('div', { className: 'cr-invite-note', style: { color: 'var(--cr-danger)' } }, tr('roomGone'))
                : props.link && props.link.status === 'offline'
                  ? h('div', { className: 'cr-invite-note', style: { color: 'var(--cr-danger)' } }, props.link.error || '离线')
                  : props.link && props.link.hostOld
                    ? h('div', { className: 'cr-warn' }, tr('hostOldHint'))
                    : h('div', { className: 'cr-invite-note' }, tr('remoteRules')),
              h(
                'button',
                { className: 'cr-btn cr-danger', onClick: props.onLeaveRemote },
                room.remote && room.remote.lost ? tr('removeRoom') : tr('leaveLan'),
              ),
            )
          : null,
      )
    }

    /**
     * 「说了一句，谁都没接」时该不该解释一句。
     *
     * 默认规则只有「被 @ 才回」，所以新用户建屋、加 agent、问一句「你好」，
     * 得到的是完全的安静 —— 界面原来对此一个字都不说，看着像插件坏了。
     *
     * 这里不去猜宿主调度到了哪一步（那是异步的，猜早了会误报），只看投影里
     * 已经有的事实：最后一条是不是我刚说的、屋里有没有 agent、我有没有点到它、
     * 三条规则此刻还有没有人能接话。条件一变（agent 接话了 / 我再说一句 / 规则被打开），
     * 它自己就消失 —— 不需要额外状态，也不会出现「解释完了还一直挂着」。
     *
     * compact 给浮窗用：那里点不到「让全员说一轮」和「规则」这两个按钮，
     * 所以不能照着面板的说法指路。加入方的镜像房间同理（规则只能宿主改）。
     */
    /**
     * 房间里「正在发生什么」的那一行。
     *
     * 两种等待长得不一样，说的事情也不同：agent 正在说，和这一轮正等着本机的人点授权。
     * 后者在授权窗口旁边也得有痕迹 —— 否则浮窗收着、面板切走时，人只看到屋里一直安静，
     * 而对面那台机器还以为这边在思考。
     */
    function activityLine(room, tr) {
      if (!room || !room.activity) return null
      if (room.activity.awaiting) return tr('awaitAuth') + ' · ' + room.activity.awaiting
      var speaking = room.activity.speaking || []
      if (!speaking.length) return null
      return tr('speaking') + ' ' + speaking.join('、')
    }

    function silenceNote(room, selfId, tr, compact) {      if (!room) return null
      if (room.remote && room.remote.lost) return null // 屋子已经散了，输入也锁着，不必解释
      var messages = room.messages
      if (!messages || !messages.length) return null
      var last = messages[messages.length - 1]
      if (!last || last.authorId !== selfId || last.status !== 'sent') return null
      // 正在发言时不插嘴：那时下面已经有「正在发言 X」在解释界面。
      if (room.activity && room.activity.speaking && room.activity.speaking.length) return null
      var bots = room.members.filter(function (member) {
        return member.kind === 'bot'
      })
      // 屋里压根没有 agent：该去右栏建一个，不是「没叫到」。
      if (!bots.length) return null
      var rules = room.rules || {}
      if (rules.roundRobin || rules.chairId) return null // 这两条规则会自己接话
      var called = (last.mentions || []).some(function (id) {
        return bots.some(function (bot) {
          return bot.id === id
        })
      })
      if (rules.mention) {
        if (called) return null
        if (compact) return tr('hintCompact')
        return room.remote ? tr('hintNotAddressedRemote') : tr('hintNotAddressed')
      }
      // 连「被 @ 才回」都关着：这时就算点名也没人接，得先说清是规则的事。
      if (compact || room.remote) return tr('hintCompactRulesOff')
      return tr('hintRulesOff')
    }

    /**
     * 把「翻回来的更早几页」和新投影拼成一条没有重复的时间线。
     *
     * 拼接处不假设顺序：新投影会随着新消息往前挪窗口，同一句有机会同时出现在
     * 已经翻出来的那几页和投影里。按 seq 去重再排序，比「谁在前谁在后」可靠。
     */
    function mergeOlder(previous, incoming) {
      var seen = {}
      var out = []
      var all = (incoming || []).concat(previous || [])
      for (var row of all) {
        if (!row || typeof row.seq !== 'number' || seen[row.seq]) continue
        seen[row.seq] = true
        out.push(row)
      }
      out.sort(function (a, b) {
        return a.seq - b.seq
      })
      return out
    }

    function RoomsPanel(props) {
      var store = props.store
      var tr = props.tr
      var view = useStore(store)
      var snapshot = view.snapshot
      var ui = props.ui
      // 房间列表可以收起来，把宽度让给消息区；这个状态记在 localStorage 里，下次照样。
      var [navCollapsed, setNavCollapsed] = React.useState(readNavCollapsed)
      function toggleNav(collapsed) {
        setNavCollapsed(collapsed)
        saveNavCollapsed(collapsed)
      }
      // 聊天区可拖宽：宽度存在 --cr-flow-max，拖动右缘的手柄改它，松手落盘。
      var [flowMax, setFlowMax] = React.useState(readFlowMax)
      var flowMaxRef = React.useRef(flowMax)
      function applyFlowMax(value) {
        flowMaxRef.current = value
        setFlowMax(value)
      }
      function startFlowResize(event) {
        event.preventDefault()
        var col = event.currentTarget.parentElement
        if (!col) return
        var rect = col.getBoundingClientRect()
        // 内容是居中的：手柄在正文右缘，往右拖 dx，宽度增加 2dx，指针才能跟手。
        var centerX = rect.left + rect.width / 2
        var maxWidth = Math.max(FLOW_MAX_MIN, rect.width - 24)
        function onMove(ev) {
          var width = Math.round((ev.clientX - centerX) * 2)
          applyFlowMax(Math.max(FLOW_MAX_MIN, Math.min(width, maxWidth)))
        }
        function onUp() {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
          document.body.style.cursor = ''
          saveFlowMax(flowMaxRef.current)
        }
        document.body.style.cursor = 'col-resize'
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
      }
      function resetFlowMax() {
        applyFlowMax(FLOW_MAX_DEFAULT)
        saveFlowMax(FLOW_MAX_DEFAULT)
      }

      React.useEffect(() => {
        store.set({ panelMounted: true })
        if (!view.snapshot) store.refresh()
        return () => store.set({ panelMounted: false })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      // 面板停在某间屋子上，就等于「读过了」：把游标推到最新一条，未读徽标才会消。
      // 但「挂着」不等于「看得见」：DSH 的侧栏面板被切走之后通常还留在 DOM 里，
      // 标签页切到后台也一样。无条件清已读会把提醒废掉（用户根本没看，未读就没了），
      // 所以先确认这块面板真的在屏幕上。
      // 另外用 ref 记「已经报过哪个 seq」：每次轮询回来的新投影都会再触发一次，
      // 每报一次宿主就 +1 revision，不记就会自己喂自己成死循环。
      var panelRef = React.useRef(null)
      var marked = React.useRef({ roomId: null, seq: 0 })
      // 面板要跟着新消息走：agent 的回复是异步补进来的，停在顶上就等于「说了话看不到」。
      // 但用户自己往上翻历史时不能把他拽下来 —— 只有本来就在底部才跟。
      var flowRef = React.useRef(null)
      var follow = React.useRef({ roomId: null, seq: null })
      // 往回翻完历史，人停在上面；这之后进来的新消息他看不见。给一个明确出口，
      // 别让人拿滚轮一路滚到底（长房间那是几百行的距离）。
      var [away, setAway] = React.useState(false)
      // 停在上面读历史的时候进来的话，用户在屏幕上根本看不见。出口上要写清「几条新的」——
      // 否则这枚按钮和一直挂着没区别，agent 回了什么还得自己找。
      var [fresh, setFresh] = React.useState(0)
      function measureFlow() {
        var node = flowRef.current
        if (!node) return
        var gap = node.scrollHeight - node.scrollTop - node.clientHeight
        setAway(gap > 160)
        // 人自己滚回底部，等于看过最新那句了，计数清零。
        if (gap <= 160) setFresh(0)
      }
      function jumpToLatest() {
        var node = flowRef.current
        setAway(false)
        setFresh(0)
        if (node) node.scrollTop = node.scrollHeight
      }
      // 投影只带最近 200 条。往回翻过的那页停在更早的位置，新消息一进来投影整体往前滑，
      // 两段中间就裂出一道缝：那几句既不在翻出来的那页里、也不在投影里，谁都不去要
      // 就永远看不见（时间戳会突然从 11/03 跳到 11/05）。补一次，按投影的首句往回要。
      var seam = React.useRef({ roomId: null, seq: null })
      function fillSeam(current) {
        var paged = ui.older
        if (!paged || paged.roomId !== current.id || paged.loading || !paged.items.length) return
        if (!current.messages.length) return
        var windowFirst = current.messages[0].seq
        var olderLast = 0
        for (var index = 0; index < paged.items.length; index += 1) {
          if (paged.items[index].seq > olderLast) olderLast = paged.items[index].seq
        }
        if (!olderLast || windowFirst <= olderLast + 1) return
        if (seam.current.roomId === current.id && seam.current.seq === windowFirst) return
        seam.current = { roomId: current.id, seq: windowFirst }
        store
          .pageOlder(current.id, windowFirst)
          .then(function (page) {
            var rows = page && page.messages ? page.messages : []
            if (!rows.length) return
            ui.setOlder({
              roomId: current.id,
              items: mergeOlder(paged.items, rows),
              hasMore: paged.hasMore,
              loading: false,
            })
          })
          .catch(function () {})
      }
      React.useEffect(() => {
        var node = flowRef.current
        var current = store.activeRoom()
        if (!node || !current) return
        var last = current.messages.length ? current.messages[current.messages.length - 1].seq : 0
        var same = follow.current.roomId === current.id
        var previous = follow.current.seq
        follow.current = { roomId: current.id, seq: last }
        if (same && previous === last) return
        var nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120
        if (!same || previous === null || nearBottom) {
          node.scrollTop = node.scrollHeight
        } else if (last > previous) {
          // 人在上头读历史：不把他拽下来，只把「新进来几条」记在出口上。
          var added = 0
          for (var index = 0; index < current.messages.length; index += 1) {
            if (current.messages[index].seq > previous) added += 1
          }
          if (added) setFresh((count) => count + added)
          fillSeam(current)
        }
        measureFlow()
      })
      React.useEffect(() => {
        var snap = view.snapshot
        if (!snap) return
        var node = panelRef.current
        if (!node || node.offsetParent === null || document.visibilityState !== 'visible') return
        var current = snap.rooms.find((row) => row.id === snap.activeRoomId)
        if (!current || !current.unread) return
        if (current.remote && current.remote.lost) return
        var seq = current.nextSeq - 1
        if (marked.current.roomId === current.id && marked.current.seq === seq) return
        marked.current = { roomId: current.id, seq: seq }
        store.command('read.mark', { roomId: current.id, seq: seq }).catch(() => {})
      })

      if (!snapshot) {
        return h('div', { className: 'cr-main' }, h('div', { className: 'cr-empty' }, view.error || '…'))
      }
      var room = store.activeRoom()
      // 收起后左边只留一条窄轨：顶部一颗展开键，下面把每间屋子画成头像（不是只报个数），
      // 点哪个头像就切到哪间屋，和展开时的房间列表同一种信息。
      var navRail = h(
        'div',
        { className: 'cr-col cr-nav-rail' },
        h(
          'button',
          {
            className: 'cr-btn cr-nav-rail-expand',
            title: tr('expandRooms'),
            'aria-label': tr('expandRooms'),
            onClick: () => toggleNav(false),
          },
          h('span', { className: 'cr-chevron', 'aria-hidden': 'true' }, '»'),
        ),
        h(
          'div',
          { className: 'cr-rail-rooms' },
          snapshot.rooms.map((row) =>
            h(
              'button',
              {
                key: row.id,
                className: 'cr-rail-room' + (row.id === snapshot.activeRoomId ? ' cr-on' : ''),
                title: row.name,
                'aria-label': row.name,
                onClick: () => store.command('room.activate', { roomId: row.id }).catch(() => {}),
              },
              h('span', { className: 'cr-rail-avatar' }, initial(row.name)),
              row.unread > 0
                ? h('span', { className: 'cr-rail-badge' }, row.unread > 99 ? '99+' : String(row.unread))
                : null,
            ),
          ),
        ),
      )
      var pending = view.pending.filter((row) => !room || row.roomId === room.id)
      // 这一轮还在发言（或正等着本机授权）时，宿主会拿 room_busy 把重试打回来 —— 先把按钮按住。
      var working = activityLine(room, tr)
      var busy = Boolean(working)
      // 说完一句、谁都没接的时候，界面得说清是「没叫到人」还是「规则全关着」——
      // 默认只有「被 @ 才回」，不解释的话第一次用就是一片安静。
      var hint = silenceNote(room, snapshot.self.id, tr)
      // 投影只带最近 200 条：屋子更长时，更早那些话只有宿主那边还留着。
      // 顶部那枚「加载更早的消息」是它们唯一的入口 —— 少了它，说过的话在界面上
      // 就等于不存在，只剩一句「只显示最近 200 条」。
      var older = room && ui.older && ui.older.roomId === room.id ? ui.older : null
      var olderItems = older ? older.items : []
      var canOlder = room ? (older ? older.hasMore : Boolean(room.truncated)) : false
      var timeline = room ? (olderItems.length ? mergeOlder(olderItems, room.messages) : room.messages) : []

      /**
       * 翻回一页更早的消息。
       *
       * 翻完要自己把视口接回去：内容是在顶上长出来的，浏览器不会替你抵消这段高度，
       * 用户在读的那句会突然掉下去。这里按「翻页前离内容底部的距离」反推 scrollTop。
       */
      function loadOlder() {
        if (!room || (older && older.loading)) return
        var known = olderItems.length ? olderItems : room.messages
        var first = null
        for (var row of known) {
          if (first === null || row.seq < first) first = row.seq
        }
        if (first === null) return
        var box = flowRef.current
        var keep = box ? box.scrollHeight - box.scrollTop : 0
        ui.setOlder({ roomId: room.id, items: olderItems, hasMore: true, loading: true })
        store
          .pageOlder(room.id, first)
          .then(function (page) {
            ui.setOlder({
              roomId: room.id,
              items: mergeOlder(olderItems, page && page.messages ? page.messages : []),
              hasMore: Boolean(page && page.hasMore),
              loading: false,
            })
            window.requestAnimationFrame(function () {
              var node = flowRef.current
              if (!node) return
              var target = node.scrollHeight - keep
              node.scrollTop = target < 0 ? 0 : target
              measureFlow()
            })
          })
          .catch(function (error) {
            ui.setOlder({ roomId: room.id, items: olderItems, hasMore: true, loading: false })
            store.set({ error: String((error && error.message) || error) })
          })
      }

      function retry(message) {
        if (!room || room.remote) return
        ui.setRetrySeq(message.seq)
        store
          .command('msg.retry', { roomId: room.id, seq: message.seq })
          .catch(() => {})
          .then(() => ui.setRetrySeq(null))
      }

      function send() {
        if (!room) return
        var text = store.draftOf(room.id).trim()
        if (!text) return
        var mentions = room.members
          .filter((member) => text.includes('@' + member.name))
          .map((member) => member.id)
        store.setDraft(room.id, '')
        store.send(room.id, text, mentions)
      }

      return h(
        'div',
        { className: 'cr-main', ref: panelRef, style: { '--cr-flow-max': flowMax + 'px' } },
        view.error ? h('div', { className: 'cr-error-bar' }, tr('error') + '：' + view.error) : null,
        h(
          'div',
          { className: 'cr-grid' + (snapshot.rooms.length ? '' : ' cr-grid-first') + (navCollapsed ? ' cr-nav-collapsed' : '') },
          navCollapsed ? navRail : h(RoomList, {
            snapshot: snapshot,
            store: store,
            tr: tr,
            creating: ui.creating,
            onCollapse: () => toggleNav(true),
            formName: ui.formName,
            formTopic: ui.formTopic,
            // 建屋时自己挑的那一档：不挑按钮就是灰的（见 RoomList 里的提示）。
            formColor: ui.formColor,
            onFormColor: ui.setFormColor,
            joinOpen: ui.joinOpen,
            joinHost: ui.joinHost,
            joinCode: ui.joinCode,
            joinColor: ui.joinColor,
            onJoinColor: ui.setJoinColor,
            // 「我的 agent」新建表单里的色块只在本机屋里有意义；镜像房间里座位由宿主安排。
            localRoomId: room && !room.remote ? room.id : null,
            selfName: snapshot.self.name,
            selfColor: snapshot.self.color,
            // 旧宿主把颜色当身份存（投影里没有 colorScope）：所有选颜色的入口都不画 ——
            // 画出来点了也只会改掉全局色，和「跟着房间走」是两回事。
            canPalette: snapshot.self.colorScope === 'room',
            // 没有当前屋子时也没有「这间屋里的我」，同样不画。
            canColor: snapshot.self.colorScope === 'room' && Boolean(room),
            onSelfColor: (color) => {
              if (!room) return
              store.command('self.color', { roomId: room.id, color: color }).catch(() => {})
            },
            nameDraft: ui.nameDraft,
            onNameDraft: ui.setNameDraft,
            bots: snapshot.bots || [],
            myForm: ui.myForm,
            onMyDraft: (patch) => ui.setMyForm(Object.assign({}, ui.myForm, patch)),
            onMyCancel: () => ui.setMyForm(null),
            onRemoveMy: (botId) => {
              ui.setConfirmBot(null)
              store.command('bot.remove', { botId: botId }).catch(() => {})
            },
            confirmBot: ui.confirmBot,
            onAskRemove: (botId) => ui.setConfirmBot(botId),
            onCancelRemove: () => ui.setConfirmBot(null),
            onToggleMy: () =>
              ui.setMyForm(ui.myForm ? null : { name: '', role: '', cwd: '', color: null, pickedColor: false }),
            onMySave: () => {
              var form = ui.myForm
              if (!form) return
              var name = form.name.trim()
              if (!name) return
              // 本地房间里有位置就顺手放进去；镜像房间的成员在宿主那边，交给 bot.create 里的上报。
              var target = room && !room.remote ? room.id : null
              var payload = { name: name, role: form.role.trim(), roomId: target }
              if (form.cwd && form.cwd.trim()) payload.cwd = form.cwd.trim()
              // 没点过颜色就不传：让宿主挑一个这间屋还没人用的，而不是把它按成一档「选过」。
              if (target && form.pickedColor && form.color) payload.color = form.color
              store
                .command('bot.create', payload)
                .then(() => ui.setMyForm(null))
                .catch(() => {})
            },
            onToggleCreate: () => {
              ui.setCreating(!ui.creating)
              ui.setFormColor(null)
            },
            onFormName: ui.setFormName,
            onFormTopic: ui.setFormTopic,
            onToggleJoin: () => {
              ui.setJoinOpen(!ui.joinOpen)
              ui.setJoinColor(null)
            },
            onJoinHost: ui.setJoinHost,
            onJoinCode: ui.setJoinCode,
            // 离开输入框或回车才提交：一边打字一边发 RPC 会把状态机打满。
            onCommitName: () => {
              // 没动过这个框（null）：失焦不该白跑一次改名。
              var draft = ui.nameDraft
              if (draft === null) return
              var label = draft.trim()
              // 删空了、或者跟现在一样：退回显示当前名字，不发请求。
              if (!label || label === snapshot.self.name) {
                ui.setNameDraft(null)
                return
              }
              store
                .command('self.rename', { name: label })
                .then(() => {
                  ui.setNameDraft(null)
                })
                .catch(() => {})
            },
            onJoin: () => {
              var host = ui.joinHost.trim()
              var code = ui.joinCode.trim().toUpperCase()
              var color = ui.joinColor
              // 三样缺一不可：地址、房间码、以及我要在这间屋里坐的那一档。
              if (!host || !code || (snapshot.self.colorScope === 'room' && !color)) return
              store
                .command('lan.join', { host: host, code: code, color: color || undefined })
                .then(() => {
                  ui.setJoinHost('')
                  ui.setJoinCode('')
                  ui.setJoinColor(null)
                  ui.setJoinOpen(false)
                })
                // 失败不关表单：房间码错、或者这一档已经有人坐了，人得能就地改一个再试。
                .catch(() => {})
            },
            onCreate: () => {
              var name = ui.formName.trim()
              var color = ui.formColor
              if (!name || (snapshot.self.colorScope === 'room' && !color)) return
              store.command('room.create', { name: name, topic: ui.formTopic.trim(), color: color || undefined }).then(() => {
                ui.setFormName('')
                ui.setFormTopic('')
                ui.setFormColor(null)
                ui.setCreating(false)
              })
            },
            onActivate: (roomId) => store.command('room.activate', { roomId: roomId }),
          }),
          room
            ? h(
                'div',
                { className: 'cr-col cr-col-flow' },
                // 正文区右缘的拖拽手柄：左右拖动改 --cr-flow-max，仍居中，只是更宽/更窄。
                h('div', {
                  className: 'cr-flow-resize',
                  role: 'separator',
                  'aria-orientation': 'vertical',
                  title: tr('resizeChat'),
                  'aria-label': tr('resizeChat'),
                  onPointerDown: startFlowResize,
                  onDoubleClick: resetFlowMax,
                }),
                h(
                  'div',
                  { className: 'cr-room-head' },
                  h(
                    'div',
                    { className: 'cr-room-head-top' },
                    h('span', { className: 'cr-room-title' }, room.name),
                    room.remote
                      ? h(
                          'span',
                          { className: 'cr-chip cr-lan' },
                          tr('hostedBy') + ' ' + (room.remote.machine || room.remote.host),
                        )
                      : h('span', { className: 'cr-chip' }, tr('code') + ' ' + room.code),
                    room.remote && room.remote.lost
                      ? h('span', { className: 'cr-chip cr-danger' }, tr('goneTag'))
                      : null,
                    h('span', { className: 'cr-grow' }),
                    room.remote
                      ? null
                      : h(
                          'button',
                          { className: 'cr-btn cr-ghost', onClick: () => ui.setInviteOpen(!ui.inviteOpen) },
                          tr('invite'),
                        ),
                    room.remote
                      ? null
                      : h(
                          'button',
                          { className: 'cr-btn cr-ghost', onClick: () => ui.setRulesOpen(!ui.rulesOpen) },
                          tr('rules'),
                        ),
                    room.remote
                      ? null
                      : h(
                          'button',
                          {
                            className: 'cr-btn cr-ghost',
                            onClick: () => {
                              if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
                                if (!window.confirm(tr('clearAsk'))) return
                              }
                              store.command('room.clear', { roomId: room.id }).catch(() => {})
                            },
                          },
                          tr('clearHistory'),
                        ),
                  ),
                  // 主题另起一行：它经常是整句话，挤在标题行里只能被截成「…」。
                  room.topic ? h('div', { className: 'cr-room-head-sub', title: room.topic }, room.topic) : null,
                ),
                !room.remote && ui.inviteOpen ? h(InviteBar, { room: room, lan: snapshot.lan, tr: tr }) : null,
                h(
                  'div',
                  { className: 'cr-flow', ref: flowRef, onScroll: measureFlow },
                  canOlder
                    ? h(
                        'div',
                        { className: 'cr-older' },
                        h(
                          'button',
                          {
                            className: 'cr-older-btn',
                            disabled: Boolean(older && older.loading),
                            onClick: loadOlder,
                          },
                          older && older.loading ? tr('olderLoading') : tr('older'),
                        ),
                      )
                    : null,
                  timeline.length === 0
                    ? h('div', { className: 'cr-empty' }, tr('noMessages'))
                    : timeline.flatMap((message, index) => {
                        var previous = index > 0 ? timeline[index - 1] : null
                        var nodes = []
                        var day = dayKey(message.at)
                        // 跨天时插一条日期分隔：不插的话，隔夜的历史和今天的话看不出分界。
                        if (day && day !== (previous ? dayKey(previous.at) : '')) {
                          nodes.push(h('div', { key: 'day:' + day, className: 'cr-day' }, h('span', null, dayLabel(message.at))))
                        }
                        nodes.push(
                          h(MessageRow, {
                            key: message.id,
                            message: message,
                            // 同一个人连说几句：并成一组，头像与署名只留第一句。
                            cont: sameBurst(previous, message),
                            members: room.members,
                            selfId: snapshot.self.id,
                            tr: tr,
                            // 加入方的镜像是只读的：重试由宿主那台机器发起。
                            onRetry: room.remote ? null : retry,
                            retrying: ui.retrySeq === message.seq,
                            busy: busy,
                          }),
                        )
                        return nodes
                      }),
                  pending.map((row) =>
                    h(MessageRow, {
                      key: row.opKey,
                      message: {
                        id: row.opKey,
                        seq: -1,
                        at: row.at,
                        authorId: snapshot.self.id,
                        authorName: snapshot.self.name,
                        authorKind: 'human',
                        text: row.text,
                        status: 'sent',
                        origin: { kind: 'local' },
                      },
                      members: room.members,
                      selfId: snapshot.self.id,
                      tr: tr,
                    }),
                  ),
                  room.activity && room.activity.streaming
                    ? (function () {
                        var draft = room.activity.streaming
                        var draftMember = room.members.filter(function (m) { return m.name === draft.name })[0]
                        return h(MessageRow, {
                          key: 'streaming-draft',
                          message: {
                            id: 'streaming-draft',
                            seq: -2,
                            at: new Date().toISOString(),
                            authorId: draftMember ? draftMember.id : 'streaming-draft',
                            authorName: draft.name,
                            authorKind: 'bot',
                            text: (draft.text || '') + ' ▌',
                            status: 'sent',
                            origin: { kind: 'local' },
                          },
                          members: room.members,
                          selfId: snapshot.self.id,
                          tr: tr,
                          busy: busy,
                        })
                      })()
                    : null,
                  working
                    ? h(
                        'div',
                        { className: 'cr-thinking' },
                        h('span', null, working),
                        h('span', { className: 'cr-dot' }),
                        h('span', { className: 'cr-dot' }),
                        h('span', { className: 'cr-dot' }),
                      )
                    : null,
                  hint ? h('div', { className: 'cr-hint' }, hint) : null,
                  away
                    ? h(
                        'button',
                        { className: 'cr-jump', onClick: jumpToLatest },
                        h('span', { className: 'cr-jump-arrow', 'aria-hidden': 'true' }, '↓'),
                        h('span', { className: 'cr-jump-label' }, tr('jumpLatest')),
                        fresh
                          ? h(
                              'span',
                              { className: 'cr-jump-fresh' },
                              h('span', { className: 'cr-jump-sep' }, ' · '),
                              h('span', { className: 'cr-jump-badge' }, String(fresh)),
                              h('span', { className: 'cr-jump-more' }, ' ' + tr('jumpFresh')),
                            )
                          : null,
                      )
                    : null,
                ),
                h(Composer, {
                  room: room,
                  tr: tr,
                  selfName: snapshot.self.name,
                  draft: store.draftOf(room.id),
                  onDraft: (value) => store.setDraft(room.id, value),
                  onSend: send,
                  onRound: () => {
                    var speaking = room.activity && room.activity.speaking && room.activity.speaking.length
                    return speaking ? store.command('round.stop', { roomId: room.id }) : store.command('round.run', { roomId: room.id })
                  },
                }),
              )
            : h(
                'div',
                { className: 'cr-col cr-first' },
                h(
                  'div',
                  { className: 'cr-first-inner' },
                  h('div', { className: 'cr-first-title' }, tr('firstTitle')),
                  h('p', { className: 'cr-first-text' }, tr('firstText')),
                  h(
                    'div',
                    { className: 'cr-first-actions' },
                    h('button', { className: 'cr-btn cr-primary', onClick: () => ui.setCreating(true) }, tr('newRoom')),
                    h('button', { className: 'cr-btn cr-ghost', onClick: () => ui.setJoinOpen(true) }, tr('joinLan')),
                  ),
                  h('p', { className: 'cr-first-note' }, tr('firstNote')),
                ),
              ),
          room
            ? h(MembersColumn, {
                room: room,
                tr: tr,
                selfId: snapshot.self.id,
                // 本机授权：不是房间的规则，所以单独给；加入方同样能改自己这台。
                // 宿主是旧版本时快照里没有 auth：整块不画 —— 画出来也点不动（没有 auth.set），
                // 只会让人以为「改了没生效」。重新装载插件之后它自己就出现了。
                auth: snapshot.auth || null,
                onAuth: (level) => store.command('auth.set', { level: level }).catch(() => {}),
                rulesOpen: ui.rulesOpen,
                pickingAgent: ui.pickingAgent,
                remote: Boolean(room.remote),
                // 旧宿主没有「颜色跟着房间走」这回事：整块选色入口都不画。
                canPalette: snapshot.self.colorScope === 'room',
                link: (snapshot.links || []).find((link) => link.localRoomId === room.id) || null,
                peers: ((snapshot.lan || {}).peers || []).filter(
                  (peer) => !peer.roomId || peer.roomId === room.id,
                ),
                directory: snapshot.bots.filter((bot) => !room.members.some((member) => member.botId === bot.id)),
                agentForm: ui.agentForm,
                onAgentDraft: (patch) => ui.setAgentForm(Object.assign({}, ui.agentForm, patch)),
                onAgentCancel: () => ui.setAgentForm(null),
                onAgentSave: () => {
                  var form = ui.agentForm
                  if (!form) return
                  var name = form.name.trim()
                  if (!name) return
                  var role = form.role.trim()
                  // 名字/职责是这个 agent 自己的；颜色是「它在这间屋里坐哪一档」，
                  // 存在成员上。所以改一只已经进屋的 agent 要发两个动作：
                  // 先改色（被占了就整次停下，不能名字改了颜色没改），再改名字/职责。
                  var color = form.pickedColor && form.color ? form.color : null
                  var cwd = form.cwd ? form.cwd.trim() : ''
                  if (form.memberId) {
                    var first = color
                      ? store.command('member.update', {
                          roomId: room.id,
                          memberId: form.memberId,
                          patch: { color: color },
                        })
                      : Promise.resolve(null)
                    first
                      .then(() => store.command('bot.update', { botId: form.botId, name: name, role: role, cwd: cwd }))
                      .then(() => ui.setAgentForm(null))
                      .catch(() => {})
                  } else {
                    store.command(
                      'member.createBot',
                      Object.assign({ roomId: room.id, name: name, role: role, cwd: cwd }, color ? { color: color } : {}),
                    )
                      .then(() => ui.setAgentForm(null))
                      .catch(() => {})
                  }
                },
                onEditAgent: (member) => {
                  var bot = (snapshot.bots || []).find((row) => row.id === member.botId)
                  if (!bot) return
                  ui.setPickingAgent(false)
                  // 先把这间屋里它现在坐的那一档显示出来（它是真的），但不算「人点过」——
                  // 不碰就不该触发一次改色。
                  ui.setAgentForm({
                    botId: bot.id,
                    memberId: member.id,
                    name: bot.name,
                    role: bot.role || '',
                    cwd: bot.cwd || '',
                    color: member.color || null,
                    pickedColor: false,
                  })
                },
                onNewAgent: () => {
                  ui.setPickingAgent(false)
                  ui.setAgentForm({ botId: null, memberId: null, name: '', role: '', cwd: '', color: null, pickedColor: false })
                },
                onRules: (patch) => store.command('room.update', { roomId: room.id, rules: patch }),
                onRemove: (memberId) => store.command('member.remove', { roomId: room.id, memberId: memberId }),
                onDissolve: () => {
                  ui.setConfirmDissolve(false)
                  store.command('room.dissolve', { roomId: room.id })
                },
                confirmDissolve: ui.confirmDissolve,
                onAskDissolve: () => ui.setConfirmDissolve(true),
                onCancelDissolve: () => ui.setConfirmDissolve(false),
                onLeaveRemote: () => {
                  var found = (snapshot.links || []).find((link) => link.localRoomId === room.id)
                  if (found) store.command('lan.leave', { linkId: found.id }).catch(() => {})
                },
                onAddAgent: () => {
                  if (ui.pickingAgent) {
                    ui.setPickingAgent(false)
                    return
                  }
                  // 手上还没有 agent 就直接填表单；已经有几个就先把它们列出来，末行也能新建。
                  if ((view.snapshot.bots || []).length === 0) {
                    ui.setAgentForm({ botId: null, memberId: null, name: '', role: '', cwd: '', color: null, pickedColor: false })
                  } else ui.setPickingAgent(true)
                },
                onPickAgent: (botId) => {
                  ui.setPickingAgent(false)
                  store.command('member.addBot', { roomId: room.id, botId: botId })
                },
              })
            : null,
        ),
      )
    }

    /** 悬浮窗：会话界面里那块独立的聊天框。 */
    function useFloat(store, tr, room) {
      var view = useStore(store)
      var dragRef = React.useRef(null)
      var floatRef = React.useRef(null)
      var flowRef = React.useRef(null)
      var scrollKey = React.useRef('')
      var suppressClick = React.useRef(false)
      var [dragging, setDragging] = React.useState(false)
      var [retrySeq, setRetrySeq] = React.useState(null)
      // 草稿跟着屋子走（和面板共用同一份）：浮窗开着、人在面板里换到别的屋，
      // 这边输入框里那半句话不许跟着搬过去。
      var draft = room ? store.draftOf(room.id) : ''
      var setDraft = (value) => {
        if (room) store.setDraft(room.id, value)
      }

      // 记住的坐标可能来自一个更大的窗口：位置一变（含重开页面）就先按当前视口夹一次。
      React.useEffect(() => {
        if (!view.floatPos) return
        var node = floatRef.current
        var rect = node ? node.getBoundingClientRect() : null
        var next = clampFloat(view.floatPos.x, view.floatPos.y, rect ? rect.width : 296, rect ? rect.height : 360)
        if (next.x !== view.floatPos.x || next.y !== view.floatPos.y) {
          store.set({ floatPos: next })
          saveFloatPos(next)
        }
      }, [view.floatPos, view.floatOpen])

      // 窗口被拖窄时也要夹：否则浮窗连标题栏都在屏幕外，拖都拖不回来。
      React.useEffect(() => {
        function onResize() {
          var current = store.get().floatPos
          if (!current) return
          var node = floatRef.current
          var rect = node ? node.getBoundingClientRect() : null
          var next = clampFloat(current.x, current.y, rect ? rect.width : 296, rect ? rect.height : 360)
          if (next.x !== current.x || next.y !== current.y) {
            store.set({ floatPos: next })
            saveFloatPos(next)
          }
        }
        window.addEventListener('resize', onResize)
        return function () {
          window.removeEventListener('resize', onResize)
        }
      }, [])

      /* 拖动对胶囊和展开的卡片一视同仁：收起成胶囊以后它也得能拖 —— 两者共用同一个位置，
       * 只是窗口小了一号。所以监听常驻，收起状态不再提前 return。 */
      function beginDrag(event) {
        if (event.button > 0) return
        var node = floatRef.current
        if (!node) return
        var rect = node.getBoundingClientRect()
        suppressClick.current = false
        dragRef.current = {
          dx: event.clientX - rect.left,
          dy: event.clientY - rect.top,
          width: rect.width,
          height: rect.height,
          originX: event.clientX,
          originY: event.clientY,
          moved: false,
        }
        setDragging(true)
      }

      React.useEffect(() => {
        function onMove(event) {
          var grab = dragRef.current
          if (!grab) return
          // 手没动就不算拖：松手以后要按点击处理（收起状态点一下才是展开）。
          if (!grab.moved) {
            if (Math.abs(event.clientX - grab.originX) < 4 && Math.abs(event.clientY - grab.originY) < 4) return
            grab.moved = true
          }
          // 拖动中就不许出界：松手以后没有第二个抓手能把它拉回来。
          store.set({ floatPos: clampFloat(event.clientX - grab.dx, event.clientY - grab.dy, grab.width, grab.height) })
        }
        function onUp() {
          var grab = dragRef.current
          if (!grab) return
          dragRef.current = null
          setDragging(false)
          if (!grab.moved) return
          suppressClick.current = true
          var position = store.get().floatPos
          if (position) saveFloatPos(position)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
        return function () {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
        }
      }, [store])

      // 浮窗展开着就是「正在看」：未读随之清掉，胶囊和标题前缀上的数字才会落回去。
      var marked = React.useRef({ roomId: null, seq: 0 })
      React.useEffect(() => {
        if (!view.floatOpen || !room || !room.unread) return
        if (room.remote && room.remote.lost) return
        var seq = room.nextSeq - 1
        if (marked.current.roomId === room.id && marked.current.seq === seq) return
        marked.current = { roomId: room.id, seq: seq }
        store.command('read.mark', { roomId: room.id, seq: seq }).catch(() => {})
      })

      // 浮窗只放得下六条：新消息进来、或者窗刚展开，都要停在最后一条上，
      // 否则看到的是六条里最旧的那半句（最新一句被输入框切掉半行）。
      React.useEffect(() => {
        var node = flowRef.current
        if (!node || !room) return
        var last = room.messages.length ? room.messages[room.messages.length - 1].seq : 0
        var key = room.id + ':' + last + ':' + (view.floatOpen ? 'open' : 'shut')
        if (key === scrollKey.current) return
        scrollKey.current = key
        node.scrollTop = node.scrollHeight
      })

      if (!room) return null
      var style = view.floatPos
        ? { right: 'auto', bottom: 'auto', left: view.floatPos.x + 'px', top: view.floatPos.y + 'px' }
        : null
      var selfId = (view.snapshot && view.snapshot.self && view.snapshot.self.id) || 'me'
      // 浮窗只有一屏高，但「少了哪几条」比「多占几行 DOM」更糟：
      // 放最近 24 条，往上滚就是完整的一段对话。
      // 没回上来那条不进时间线：它不是一个「说过的句子」，而是一个待处理状态 ——
      // 重试成功以后它就该消失，历史留痕在面板里。
      var messages = room.messages.filter((message) => message.status !== 'error').slice(-24)
      var lastMessage = room.messages.length ? room.messages[room.messages.length - 1] : null
      var failed = !room.remote && lastMessage && lastMessage.status === 'error' ? lastMessage : null
      var gone = Boolean(room.remote && room.remote.lost)
      // 「正在说」和「正等着本机授权」是两种等待：都说出来，别让人以为对面卡住了。
      var working = activityLine(room, tr)
      var busy = Boolean(working)
      // 浮窗里也有输入框，也会撞上「说了一句没人接」——同一句解释，别只在面板里说。
      // 但它点不到「让全员说一轮」，所以用短的那一版。
      var hint = silenceNote(room, selfId, tr, true)
      // 收起时这一行就是「屋里刚说了什么」：没有它，人得先展开才知道值不值得展开。
      var pillSay = ''
      if (working) pillSay = working
      else if (lastMessage) pillSay = lastMessage.authorName + '：' + String(lastMessage.text || '').replace(/\s+/g, ' ').trim()
      else pillSay = tr('noMessages')
      // 标题栏第二行：浮窗里没有成员列，「这屋还有谁」只能从这一行读出来。
      var subtitle = gone
        ? tr('goneTag')
        : room.members.length +
          ' ' +
          tr('people') +
          (lanCount(room.members) ? ' · ' + lanCount(room.members) + ' ' + tr('lan') : '')
      // 失败消息只重跑那一个 agent，不惊动屋里其他人 —— 和面板里那枚按钮同一条路。
      var retry = (message) => {
        if (busy || retrySeq === message.seq) return
        setRetrySeq(message.seq)
        store
          .command('msg.retry', { roomId: room.id, seq: message.seq })
          .catch(() => {})
          .then(() => setRetrySeq(null))
      }

      if (!view.floatOpen) {
        return h(
          'div',
          { className: 'cr-float', style: style, ref: floatRef },
          h(
            'button',
            {
              className: 'cr-float-pill' + (dragging ? ' cr-dragging' : ''),
              title: tr('floatDragPill'),
              onPointerDown: beginDrag,
              onClick: (event) => {
                // 拖完松手时浏览器还会补一个 click：那一下不能顺带把窗展开。
                // 键盘激活（detail 0）不走这条，回车照样能开。
                if (suppressClick.current && event.detail !== 0) {
                  suppressClick.current = false
                  return
                }
                suppressClick.current = false
                store.set({ floatOpen: true, notice: null })
              },
            },
            h(
              'span',
              { className: 'cr-float-mark', 'aria-hidden': 'true' },
              h(WhaleMark, { size: 15 }),
            ),
            h(
              'span',
              { className: 'cr-float-pill-id' },
              h('span', { className: 'cr-float-pill-name' }, room.name),
              h('span', { className: 'cr-float-pill-say' }, pillSay),
            ),
            room.unread > 0 ? h('span', { className: 'cr-badge' }, String(room.unread)) : null,
          ),
        )
      }

      return h(
        'div',
        { className: 'cr-float', style: style, ref: floatRef },
        h(
          'div',
          { className: 'cr-float-card' },
          h(
            'div',
            {
              className: 'cr-float-head' + (dragging ? ' cr-dragging' : ''),
              title: tr('floatDrag'),
              onPointerDown: beginDrag,
              // 拖丢了也能一键回到默认角落：记下的坐标不该变成单程票。
              onDoubleClick: () => {
                dragRef.current = null
                setDragging(false)
                clearFloatPos()
                store.set({ floatPos: null })
              },
            },
            h(
              'span',
              { className: 'cr-float-mark', 'aria-hidden': 'true' },
              h(WhaleMark, { size: 15 }),
            ),
            h(
              'span',
              { className: 'cr-float-id' },
              h('span', { className: 'cr-float-title' }, room.name),
              h('span', { className: 'cr-float-sub' }, subtitle),
            ),
            h(
              'button',
              { className: 'cr-icon-btn', title: tr('floatClose'), onClick: () => store.set({ floatOpen: false }) },
              '×',
            ),
          ),
          h(
            'div',
            { className: 'cr-float-flow', ref: flowRef },
            messages.length === 0
              ? h('div', { className: 'cr-empty cr-float-empty' }, tr('noMessages'))
              : messages.flatMap((message, index) => {
                  var previous = index > 0 ? messages[index - 1] : null
                  var nodes = []
                  var day = dayKey(message.at)
                  // 跨天插一条日期分隔：浮窗里同样会看到隔夜的历史。
                  if (day && day !== (previous ? dayKey(previous.at) : '')) {
                    nodes.push(
                      h('div', { key: 'day:' + day, className: 'cr-day' }, h('span', null, dayLabel(message.at))),
                    )
                  }
                  nodes.push(
                    h(MessageRow, {
                      key: message.id,
                      message: message,
                      // 同一个人连说几句就并成一组，和面板一个口径。
                      cont: sameBurst(previous, message),
                      members: room.members,
                      selfId: selfId,
                      tr: tr,
                      // 加入方是只读镜像：重试只能由宿主那台发起。
                      onRetry: room.remote ? null : retry,
                      retrying: retrySeq === message.seq,
                      busy: busy,
                      className: 'cr-float-msg' + (message.status === 'error' ? ' cr-float-failed' : ''),
                    }),
                  )
                  return nodes
                }),
            // 没回上来那条单独挂在最后：它底下那枚「重试」只重跑一个 agent，
            // 不惊动屋里其他人 —— 和面板里是同一个动作。
            failed
              ? h(MessageRow, {
                  key: 'retry:' + failed.seq,
                  message: failed,
                  members: room.members,
                  selfId: selfId,
                  tr: tr,
                  onRetry: retry,
                  retrying: retrySeq === failed.seq,
                  busy: busy,
                  className: 'cr-float-msg cr-float-failed',
                })
              : null,
            working
              ? h(
                  'div',
                  { key: 'thinking', className: 'cr-thinking cr-float-thinking' },
                  h('span', null, working),
                  h('span', { className: 'cr-dot' }),
                  h('span', { className: 'cr-dot' }),
                  h('span', { className: 'cr-dot' }),
                )
              : null,
            hint ? h('div', { key: 'hint', className: 'cr-float-hint' }, hint) : null,
          ),
          // 输入区和面板是同一个组件：@ 候选、选词回车、草稿都共用一份行为。
          h(Composer, {
            compact: true,
            room: room,
            tr: tr,
            selfName: (view.snapshot && view.snapshot.self && view.snapshot.self.name) || tr('you'),
            draft: draft,
            onDraft: setDraft,
            onSend: () => {
              if (gone) return
              var text = draft.trim()
              if (!text) return
              setDraft('')
              store.send(room.id, text, [])
            },
          }),
        ),
      )
    }

    function props_openPanel(store) {
      // 主面板是 sidebar 的独立面板，浏览器里没有跨插件的路由 API，
      // 所以这里只负责把悬浮窗收起，让用户从侧栏进入面板。
      store.set({ floatOpen: false })
    }

    /** 侧栏图标的未读计数必须订阅，否则图标上的数字不会跟着房间变。 */
    function NavEntry(props) {
      useStore(props.store)
      return h(NavIcon, { store: props.store })
    }

    function ToastHost(props) {
      var view = useStore(props.store)
      var [dismissed, setDismissed] = React.useState(null)
      React.useEffect(() => {
        if (!view.notice) return undefined
        var id = view.notice.id
        var timer = setTimeout(function () {
          setDismissed(id)
          props.store.set({ notice: null })
        }, 5000)
        return () => clearTimeout(timer)
      }, [view.notice && view.notice.id])
      if (!view.notice || dismissed === view.notice.id) return null
      return h(
        'div',
        { className: 'cr-toast-wrap' },
        h(
          'div',
          { className: 'cr-toast', onClick: () => props.store.focusRoom(view.notice) },
          h('div', { className: 'cr-toast-name' }, view.notice.room + ' · ' + view.notice.name),
          h('div', null, view.notice.text.slice(0, 120)),
        ),
      )
    }

    /**
     * 授权窗口：另一台机器要在这台机器上跑一个 agent 回合。
     *
     * 一张卡只问一件事，从最早的那条开始。它不看浮窗开没开、也不看当前是不是聊天室那一屏 —
     * 请求可能在人在别的会话里打字的时候到。到点不点按拒绝处理（宿主那边 fail closed），
     * 所以这里只负责把剩余时间说清楚，不自己判超时。
     */
    function ApprovalHost(props) {
      var view = useStore(props.store)
      var snapshot = view.snapshot
      var tr = props.tr
      var list = (snapshot && snapshot.approvals) || []
      var [tick, setTick] = React.useState(Date.now())
      var busy = React.useRef(false)
      var bodyRef = React.useRef(null)
      var cardId = list.length ? list[0].id : ''
      React.useEffect(
        function () {
          // prompt 从头看是模板（「你正在一间群聊房间里…」），真正要做的事在最后一句：
          // 打开就停在底部，人不用先往下滚一遍才知道在批什么。
          var node = bodyRef.current
          if (node) node.scrollTop = node.scrollHeight
        },
        [cardId],
      )
      React.useEffect(
        function () {
          if (!list.length) return undefined
          setTick(Date.now())
          var timer = setInterval(function () {
            setTick(Date.now())
          }, 1000)
          return function () {
            clearInterval(timer)
          }
        },
        [list.length],
      )
      if (!list.length) return null
      var card = list[0]
      var left = Math.max(0, Math.ceil(((card.deadline || tick) - tick) / 1000))
      function decide(allow) {
        if (busy.current) return
        busy.current = true
        props.store
          .command('auth.answer', { id: card.id, allow: allow })
          .catch(function () {})
          .then(function () {
            busy.current = false
          })
      }
      return h(
        'div',
        { className: 'cr-approve', role: 'dialog', 'aria-label': tr('approveTitle') },
        h(
          'div',
          { className: 'cr-approve-head' },
          h('span', { className: 'cr-approve-eyebrow' }, tr('approveTitle')),
          list.length > 1 ? h('span', { className: 'cr-approve-count' }, '+' + (list.length - 1) + ' ' + tr('approveMore')) : null,
          h('span', { className: 'cr-approve-count' }, left + 's'),
        ),
        h('div', { className: 'cr-approve-who' }, '「' + card.agentName + '」' + tr('approveRun')),
        h(
          'div',
          { className: 'cr-approve-meta' },
          tr('approveFrom') +
            ' ' +
            (card.fromMachine || '—') +
            ' · ' +
            (card.fromName || '—') +
            '（' +
            (card.fromKind === 'bot' ? tr('agentKind') : tr('personKind')) +
            '）· ' +
            tr('approveRoom') +
            ' ' +
            card.roomName,
        ),
        // 先给一句原话：人判断「要不要让它跑」靠的是这句话，不是整段 prompt 模板。
        card.asked ? h('div', { className: 'cr-approve-quote' }, '「' + card.asked + '」') : null,
        h(
          'div',
          { className: 'cr-approve-detail' },
          h('div', { className: 'cr-approve-label' }, tr('approveFull')),
          h('div', { className: 'cr-approve-body', ref: bodyRef }, card.prompt || ''),
        ),        h(
          'div',
          { className: 'cr-approve-foot' },
          h('button', { className: 'cr-btn cr-primary', onClick: () => decide(true) }, tr('approveAllow')),
          h('button', { className: 'cr-btn cr-ghost', onClick: () => decide(false) }, tr('approveDeny')),
          h('span', { className: 'cr-grow' }),
          h('span', { className: 'cr-approve-hint' }, tr('approveHint')),
        ),
      )
    }

    function SessionToggle(props) {
      var view = useStore(props.store)
      var unread = view.snapshot
        ? view.snapshot.rooms.reduce((sum, room) => sum + (room.unread || 0), 0)
        : 0
      return h(
        'button',
        {
          className: 'cr-btn cr-ghost',
          style: { position: 'relative' },
          onClick: () => props.store.set({ floatOpen: !view.floatOpen, notice: null }),
          title: props.tr('floatOpen'),
        },
        h(NavIcon, { store: props.store, size: 14, badge: false }),
        h('span', null, props.tr('floatOpen')),
        unread > 0 ? h('span', { className: 'cr-badge' }, String(unread)) : null,
      )
    }

    /* --------------------------------------------------------------- 挂载 */

    function apply(ctx) {
      var tr = bindLocale(ctx)

      ctx.effect(function () {
        var el = document.createElement('style')
        el.setAttribute('data-dsh-chatroom', '')
        el.textContent = CSS
        document.head.appendChild(el)
        return function () {
          el.remove()
        }
      }, 'dsh-chatroom: styles')

      var rpc = createRpc(ctx)
      var store = createStore(rpc)

      // 未读提醒：页面标题前缀，标签页不聚焦时也看得见。
      var baseTitle = document.title
      var unsubscribe = store.subscribe(function () {
        var unread = store.totalUnread()
        document.title = unread > 0 ? '(' + unread + ') ' + baseTitle : baseTitle
      })

      // 全局只跑一条长轮询，面板与悬浮窗共享同一份快照。
      store.refresh().then(function () {
        store.watchLoop()
      })

      ctx.effect(function () {
        return function () {
          store.stop()
          unsubscribe()
          document.title = baseTitle
        }
      }, 'dsh-chatroom: lifetime')

      var slots = ctx.slots
      var uiState = {
        creating: false,
        formName: '',
        formTopic: '',
        // 建屋时自己挑的那一档：null = 还没挑，按钮灰着（每间屋都要重新挑）。
        formColor: null,
        rulesOpen: false,
        pickingAgent: false,
        inviteOpen: false,
        joinOpen: false,
        joinHost: '',
        joinCode: '',
        // 加入 LAN 房间时我要坐的那一档：null = 还没挑，加入按钮灰着。
        joinColor: null,
        // 「我的名字」的草稿：null = 还没动过（显示当前名字），字符串 = 正在打的内容。
        // 用 null 而不是 ''，是因为 '' 有正当含义 —— 人把框删干净的那一下。
        nameDraft: null,
        // 左栏「我的 agent」的新建表单：和成员列那个 agentForm 分开，
        // 否则打开一个，另一个也跟着弹出来。
        myForm: null,
        // 删 agent、解散屋子都收不回来：先问一次再动手，别让一次误点把东西弄没。
        confirmBot: null,
        confirmDissolve: false,
        // 正在重试的那条消息（按 seq 记）：只用来把按钮按下去，别让整片消息区重排。
        retrySeq: null,
        // 已经翻回来的更早消息：{ roomId, items, hasMore, loading }。
        // 只放界面临时翻出来的那几页 —— 它们是投影之外的东西，不写进 store 的状态，
        // 也不会被长轮询的新投影冲掉。
        older: null,
        agentForm: null,
      }
      var uiListeners = new Set()
      function useUi() {
        return React.useSyncExternalStore(
          function (listener) {
            uiListeners.add(listener)
            return function () {
              uiListeners.delete(listener)
            }
          },
          function () {
            return uiState
          },
          function () {
            return uiState
          },
        )
      }
      function setUi(patch) {
        uiState = Object.assign({}, uiState, patch)
        for (var listener of uiListeners) listener()
      }
      var ui = {
        get creating() {
          return uiState.creating
        },
        setCreating: (value) => setUi({ creating: value }),
        get formName() {
          return uiState.formName
        },
        setFormName: (value) => setUi({ formName: value }),
        get formTopic() {
          return uiState.formTopic
        },
        setFormTopic: (value) => setUi({ formTopic: value }),
        get formColor() {
          return uiState.formColor
        },
        setFormColor: (value) => setUi({ formColor: value }),
        get rulesOpen() {
          return uiState.rulesOpen
        },
        setRulesOpen: (value) => setUi({ rulesOpen: value }),
        get pickingAgent() {
          return uiState.pickingAgent
        },
        setPickingAgent: (value) => setUi({ pickingAgent: value }),
        get inviteOpen() {
          return uiState.inviteOpen
        },
        setInviteOpen: (value) => setUi({ inviteOpen: value }),
        get joinOpen() {
          return uiState.joinOpen
        },
        setJoinOpen: (value) => setUi({ joinOpen: value }),
        get joinHost() {
          return uiState.joinHost
        },
        setJoinHost: (value) => setUi({ joinHost: value }),
        get joinCode() {
          return uiState.joinCode
        },
        setJoinCode: (value) => setUi({ joinCode: value }),
        get joinColor() {
          return uiState.joinColor
        },
        setJoinColor: (value) => setUi({ joinColor: value }),
        get nameDraft() {
          return uiState.nameDraft
        },
        setNameDraft: (value) => setUi({ nameDraft: value }),
        get myForm() {
          return uiState.myForm
        },
        setMyForm: (value) => setUi({ myForm: value }),
        get confirmBot() {
          return uiState.confirmBot
        },
        setConfirmBot: (value) => setUi({ confirmBot: value }),
        get confirmDissolve() {
          return uiState.confirmDissolve
        },
        setConfirmDissolve: (value) => setUi({ confirmDissolve: value }),
        get retrySeq() {
          return uiState.retrySeq
        },
        setRetrySeq: (value) => setUi({ retrySeq: value }),
        get agentForm() {
          return uiState.agentForm
        },
        setAgentForm: (value) => setUi({ agentForm: value }),
        get older() {
          return uiState.older
        },
        setOlder: (value) => setUi({ older: value }),
      }

      function Panel() {
        // 面板重新挂载时把 ui 也挂起来，保证 useSyncExternalStore 有两份订阅。
        useUi()
        return h(RoomsPanel, { store: store, tr: tr, ui: ui })
      }

      slots.inject('sidebar.panellist', function () {
        return slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: function () { return tr('nav') } },
          function NavEntryBinding() {
            return h(NavEntry, { store: store })
          },
        )
      })
      slots.inject('main', function () {
        return slots.register({ name: 'main', key: PANEL_ID }, Panel)
      })

      try {
        slots.inject('conversation.session.header.actions', function () {
          return slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'chatroom-toggle',
              order: 200,
              label: function () { return tr('floatOpen') },
            },
            function HeaderEntry() {
              return h(SessionToggle, { store: store, tr: tr })
            },
          )
        })
      } catch (error) {
        console.warn('[dsh-chatroom] 会话头部入口未注册：' + String((error && error.message) || error))
      }

      try {
        slots.inject('shell.overlay', function () {
          return slots.register(
            { name: 'shell.overlay', id: 'chatroom-float', order: 20, label: function () { return tr('floatOpen') } },
            function FloatEntry() {
              var room = store.activeRoom()
              return h(
                'div',
                null,
                useFloat(store, tr, room),
                h(ToastHost, { store: store }),
                // 授权窗口和浮窗是两个独立的东西：一个提醒「屋里说了什么」，
                // 一个压在最上面等人做一个决定（浮窗收着的时候也可能来）。
                h(ApprovalHost, { store: store, tr: tr }),
              )
            },
          )
        })
      } catch (error) {
        console.warn('[dsh-chatroom] 悬浮窗未注册：' + String((error && error.message) || error))
      }
    }

    module.exports = { name: 'dsh-chatroom', inject: ['slots', 'locale'], apply: apply }
    return module.exports
  },
})
