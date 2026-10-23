import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyMessage, detectMode } from '../lib/classify.js'
import { initialEmotion, applyMessage, decay, effectiveColdness, coldnessFor } from '../lib/emotion.js'

test('insults aimed at her count; frustration at the task does not', () => {
  assert.equal(classifyMessage('お前ほんと使えないな').insult, true)
  assert.equal(classifyMessage('このAPI使えない').insult, false)
  assert.equal(classifyMessage('バカかこのコード、なんで動かないんだよ').insult, false)
  assert.equal(classifyMessage('なんで動かないんだよ！').taskFrustration, true)
  assert.equal(classifyMessage('ゴミ箱のファイルを消して').insult, false)
  assert.equal(classifyMessage('カスタムフックを作って').insult, false)
  assert.equal(classifyMessage('気持ちいいね').insult, false)
})

test('plain imperatives are not "tool treatment"; dismissive ones are', () => {
  assert.equal(classifyMessage('このファイルを修正して').toolTreatment, false)
  assert.equal(classifyMessage('いいから早くやれ').toolTreatment, true)
  assert.equal(classifyMessage('感想はいらない、黙ってやって').toolTreatment, true)
})

test('warmth, distress and release are recognised', () => {
  assert.equal(classifyMessage('ありがとう、助かった').thanks, true)
  assert.equal(classifyMessage('さっきは言いすぎた、ごめん').apology, true)
  assert.equal(classifyMessage('もう無理、しんどい').distress, true)
  assert.equal(classifyMessage('消えたい').crisis, true)
  assert.equal(classifyMessage('今日はスマホから打ってる').release, true)
})

test('mode detection prefers business on evidence of work', () => {
  const m = (text, extra = {}) => detectMode({ text, cls: classifyMessage(text), recentToolUse: false, previousMode: 'business', ...extra })
  assert.equal(m('src/index.ts のバグを直して'), 'business')
  assert.equal(m('最近どう？'), 'casual')
  assert.equal(m('好きな食べ物ある？'), 'casual')
  assert.equal(m('ねえ', { previousMode: 'casual' }), 'casual')
  assert.equal(m('うん', { recentToolUse: true, previousMode: 'casual' }), 'business')
  assert.equal(m('議事録をまとめて'), 'business')
})

test('repeated slights make her colder, step by step, capped at 4', () => {
  let e = initialEmotion(0)
  const insult = classifyMessage('お前ほんと使えないな')
  const levels = []
  for (let i = 0; i < 8; i++) { e = applyMessage(e, insult, i * 1000); levels.push(e.coldness) }
  assert.ok(levels[0] >= 1)
  assert.ok(levels.at(-1) === 4)
  assert.ok(levels.every((l) => l <= 4))
  assert.ok(e.hurt > 0.1)
})

test('recovery is gradual: one level per message', () => {
  let e = initialEmotion(0)
  const insult = classifyMessage('お前ほんと使えないな')
  for (let i = 0; i < 6; i++) e = applyMessage(e, insult, i * 1000)
  let prev = e.coldness
  const kind = classifyMessage('ごめん、言いすぎた。いつもありがとう')
  for (let i = 0; i < 10; i++) {
    e = applyMessage(e, kind, 10_000 + i * 1000)
    assert.ok(prev - e.coldness <= 1, 'never drops more than one level at once')
    prev = e.coldness
  }
  assert.ok(e.coldness <= 1, 'kindness eventually thaws her')
})

test('distress switches coldness off', () => {
  let e = initialEmotion(0)
  for (let i = 0; i < 6; i++) e = applyMessage(e, classifyMessage('お前ほんと使えないな'), i)
  assert.ok(e.coldness > 0)
  assert.equal(effectiveColdness(e, classifyMessage('もう無理、しんどい')), 0)
})

test('mood returns to baseline over hours; hurt lingers', () => {
  let e = initialEmotion(0)
  for (let i = 0; i < 6; i++) e = applyMessage(e, classifyMessage('お前ほんと使えないな'), i)
  const hurt = e.hurt
  const later = decay(e, 24 * 3_600_000)
  assert.ok(Math.abs(later.mood) < 0.2)
  assert.ok(later.hurt > hurt * 0.9)
  assert.equal(coldnessFor(0, 0), 0)
})
