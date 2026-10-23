import { test } from 'node:test'
import assert from 'node:assert/strict'
import { maskSecrets, makeMemory, recall, parseDistill, isHazy } from '../lib/memory.js'
import { generateBackstory, markUnlocks, revealPending, renderBackstory, shapeOk } from '../lib/backstory.js'
import { parsePersona, defaultPersonaText } from '../lib/persona.js'

const persona = parsePersona(defaultPersonaText())

test('secrets are masked before storage', () => {
  assert.equal(maskSecrets('鍵は sk-abcdefghijklmnopqrstuvwx だよ'), '鍵は [伏せ字] だよ')
  assert.equal(maskSecrets('password: hunter2'), 'password: [伏せ字]')
  assert.equal(maskSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123'), '[伏せ字]')
  assert.equal(makeMemory({ kind: 'user', text: 'APIキー: sk-abcdefghijklmnopqrstuvwx を使う' }).text.includes('sk-'), false)
})

test('recall: pinned first, then relevant; strangers do not get personal memories', () => {
  const now = Date.now()
  const mems = [
    makeMemory({ kind: 'user', text: 'ユーザーは猫を二匹飼っている', now }),
    makeMemory({ kind: 'relation', text: '初めて褒められた日、ラーメンの話で盛り上がった', now }),
    makeMemory({ kind: 'user', text: 'ユーザーの仕事は経理', now, pinned: true }),
    makeMemory({ kind: 'self', text: 'あたしは雨の音が好き', now }),
  ]
  const r = recall(mems, '猫の写真見て', { limit: 2, now })
  assert.equal(r[0].text, 'ユーザーの仕事は経理')
  assert.equal(r[1].text, 'ユーザーは猫を二匹飼っている')
  const s = recall(mems, 'ラーメン', { limit: 5, now, includePersonal: false })
  assert.ok(s.every((m) => m.kind === 'user'))
  assert.ok(!r.some((m) => m.kind === 'self'), 'self facts are injected separately')
})

test('old memories turn hazy', () => {
  const m = makeMemory({ kind: 'user', text: 'x', now: 0 })
  assert.equal(isHazy(m, 50 * 86_400_000), true)
  assert.equal(isHazy(m, 10 * 86_400_000), false)
})

test('distiller output is parsed defensively', () => {
  const out = parseDistill('```json\n{"memories":[{"kind":"user","text":"朝型"}],"intimacy":0.5,"trust":-1,"user_name":"ゆう"}\n```')
  assert.equal(out.memories.length, 1)
  assert.equal(out.intimacy, 0.05)
  assert.equal(out.trust, -0.05)
  assert.equal(out.userName, 'ゆう')
  assert.equal(parseDistill('not json'), undefined)
})

const layer = (i) => ({ level: i, text: `層${i}の本文。`.repeat(20), seeps: [`にじみ${i}a`, `にじみ${i}b`, `にじみ${i}c`] })
const candidate = { layers: [1, 2, 3, 4].map(layer), anchor: '古い腕時計' }

test('backstory: generated through verification, nothing leaks into logs', async () => {
  const calls = []
  const logs = []
  const origLog = console.log
  console.log = (...a) => logs.push(a.join(' '))
  try {
    const complete = async (_sys, user) => {
      calls.push(user.slice(0, 20))
      return user.startsWith('次の JSON') ? 'PASS' : JSON.stringify(candidate)
    }
    const doc = await generateBackstory(persona, complete, { candidates: 3 })
    assert.ok(doc)
    assert.equal(doc.layers.length, 4)
    assert.equal(doc.layers[0].unlocked, true)
    assert.equal(doc.layers.slice(1).some((l) => l.unlocked), false)
    assert.equal(calls.length, 6) // 3 candidates + 3 verifications
  } finally {
    console.log = origLog
  }
  assert.equal(logs.join('').includes('層1'), false)
})

test('backstory: FAIL verdicts produce nothing', async () => {
  const complete = async (_s, user) => (user.startsWith('次の JSON') ? 'FAIL' : JSON.stringify(candidate))
  assert.equal(await generateBackstory(persona, complete, { candidates: 2, attempts: 2 }), undefined)
  assert.equal(shapeOk({ layers: [] }), false)
})

test('backstory: unlock is one-way, staged, and locked text never reaches the prompt', () => {
  const doc = {
    layers: [1, 2, 3, 4].map((i) => ({ ...layer(i), unlockAt: [0, 0.35, 0.65, 0.9][i - 1], unlocked: i === 1, pending: false })),
    anchor: '古い腕時計',
  }
  let text = renderBackstory(doc, { mode: 'casual' })
  assert.ok(text.includes('層1の本文'))
  assert.ok(!text.includes('層2の本文'))
  assert.ok(text.includes('にじみ2a'))
  assert.deepEqual(markUnlocks(doc, 0.4), [2])
  text = renderBackstory(doc, { mode: 'casual' })
  assert.ok(!text.includes('層2の本文'), 'pending until the next casual moment')
  assert.deepEqual(revealPending(doc), [2])
  text = renderBackstory(doc, { mode: 'casual' })
  assert.ok(text.includes('層2の本文'))
  assert.deepEqual(markUnlocks(doc, 0.1), [], 'never re-locks or re-triggers')
  assert.ok(renderBackstory(doc, { mode: 'business' }).includes('過去の話は出さない'))
})
