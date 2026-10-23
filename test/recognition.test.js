import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialRecognition, observe } from '../lib/recognition.js'

// "Usual" typist: short casual lines, no 。, laughs with w, plain endings, evenings.
const usual = [
  'これ直しといてw', 'ありがと助かる', 'ねえ今日なにしてた', 'それなー', 'あとでやるわ',
  'ちょっと見てほしいんだけど', 'まじかw', 'いい感じじゃん', 'おけ、次いこ', 'うーん微妙かも',
]
// A different person: long, formal, full punctuation.
const other = [
  'お世話になっております。本日の会議資料について、内容をご確認いただけますでしょうか。',
  '恐れ入りますが、先ほどの件につきまして、詳細をご教示いただけますと幸いです。',
  '承知いたしました。引き続き、どうぞよろしくお願い申し上げます。',
]

function train(n = 40) {
  let r = initialRecognition()
  const base = Date.UTC(2026, 9, 1, 12)
  for (let i = 0; i < n; i++) r = observe(r, usual[i % usual.length], { now: base + i * 60_000 })
  return { r, t: base + n * 60_000 }
}

test('stays "usual" during warm-up no matter what', () => {
  let r = initialRecognition()
  for (const m of other) r = observe(r, m)
  assert.equal(r.state, 'usual')
})

test('the usual typist stays recognised', () => {
  let { r, t } = train()
  for (let i = 0; i < 20; i++) r = observe(r, usual[(i * 3) % usual.length], { now: t + i * 60_000 })
  assert.equal(r.state, 'usual')
})

test('a very different typist is noticed gradually, not at once', () => {
  let { r, t } = train()
  r = observe(r, other[0], { now: t })
  assert.equal(r.state, 'usual', 'one message is not enough')
  for (let i = 0; i < 12; i++) r = observe(r, other[i % other.length], { now: t + (i + 1) * 60_000 })
  assert.notEqual(r.state, 'usual')
})

test('"it is me, on my phone" releases the suspicion', () => {
  let { r, t } = train()
  for (let i = 0; i < 12; i++) r = observe(r, other[i % other.length], { now: t + i * 60_000 })
  r = observe(r, '今日はスマホから', { now: t + 20 * 60_000, release: true })
  assert.equal(r.state, 'usual')
  r = observe(r, other[0], { now: t + 21 * 60_000 })
  assert.equal(r.state, 'usual', 'stays released for a while')
})

test('profile keeps statistics only', () => {
  const { r } = train()
  const json = JSON.stringify(r)
  for (const m of usual) assert.ok(!json.includes(m))
})
