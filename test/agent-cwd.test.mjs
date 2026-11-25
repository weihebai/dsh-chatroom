import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/host/plugin.js'
import { call, fakeCtx } from './helpers/fake-ctx.mjs'

process.env.DSH_CHATROOM_PORT = '0'

async function boot(name) {
  const dir = await mkdtemp(join(tmpdir(), 'cwd-' + name + '-'))
  const fake = fakeCtx(dir)
  const dispose = await apply(fake.ctx)
  return Object.assign({ dir, dispose }, fake)
}

const cmd = (side, action, input = {}) => call(side.routes, 'command', { action, input })
const snap = async (side) => {
  const result = await call(side.routes, 'snapshot', {})
  assert.equal(result.ok, true, JSON.stringify(result.error))
  return result.value
}

test('工作目录：创建时保存、投影带出、留空是 null', async () => {
  const side = await boot('basic')
  try {
    const created = await cmd(side, 'room.create', { name: '联调' })
    const roomId = created.value.rooms[0].id
    const ok = await cmd(side, 'member.createBot', { roomId, name: '后端', cwd: side.dir })
    assert.equal(ok.ok, true, JSON.stringify(ok.error))
    const view = await snap(side)
    const bot = view.bots.find((row) => row.name === '后端')
    assert.equal(bot.cwd, side.dir)

    const plain = await cmd(side, 'member.createBot', { roomId, name: '不留目录' })
    assert.equal(plain.ok, true, JSON.stringify(plain.error))
    assert.equal((await snap(side)).bots.find((row) => row.name === '不留目录').cwd, null)
  } finally {
    await side.dispose()
  }
})

test('工作目录：相对路径、不存在、不是目录都拒绝', async () => {
  const side = await boot('bad')
  try {
    const created = await cmd(side, 'room.create', { name: '联调' })
    const roomId = created.value.rooms[0].id

    const relative = await cmd(side, 'member.createBot', { roomId, name: 'a', cwd: 'relative/dir' })
    assert.equal(relative.ok, false)
    assert.equal(relative.error.code, 'cwd_not_absolute')

    const missing = await cmd(side, 'member.createBot', { roomId, name: 'b', cwd: join(side.dir, 'nope-xyz') })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'cwd_not_found')

    const file = join(side.dir, 'a-file.txt')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, 'x')
    const notDir = await cmd(side, 'member.createBot', { roomId, name: 'c', cwd: file })
    assert.equal(notDir.ok, false)
    assert.equal(notDir.error.code, 'cwd_not_directory')
  } finally {
    await side.dispose()
  }
})

test('工作目录：bot.update 换目录会重开会话（否则 resume 还是旧目录）', async () => {
  const side = await boot('update')
  try {
    const created = await cmd(side, 'bot.create', { name: '后端', cwd: side.dir })
    assert.equal(created.ok, true, JSON.stringify(created.error))
    const before = (await snap(side)).bots[0]
    assert.equal(before.cwd, side.dir)

    const sub = join(side.dir, 'sub')
    await mkdir(sub, { recursive: true })
    const updated = await cmd(side, 'bot.update', { botId: before.id, cwd: sub })
    assert.equal(updated.ok, true, JSON.stringify(updated.error))
    const after = (await snap(side)).bots[0]
    assert.equal(after.cwd, sub)
    assert.notEqual(after.sessionId, before.sessionId, '换工作目录应该换成新会话')
  } finally {
    await side.dispose()
  }
})
