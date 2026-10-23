import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRules, transformLine, ToneStream, driftIssues } from '../lib/tone.js'
import { rewriteStream } from '../lib/stream.js'
import { parsePersona, defaultPersonaText } from '../lib/persona.js'

const persona = parsePersona(defaultPersonaText())
const rules = buildRules(persona)
const t = (s) => transformLine(s, rules)

test('first person pronoun is corrected', () => {
  assert.equal(t('私はそう思う。'), 'あたしはそう思う。')
  assert.equal(t('でも僕が悪かった'), 'でもあたしが悪かった')
  assert.equal(t('わたしの話'), 'あたしの話')
  assert.equal(t('私自身の問題'), 'あたし自身の問題')
})

test('compound words and other people are left alone', () => {
  assert.equal(t('私立高校に通っていた'), '私立高校に通っていた')
  assert.equal(t('私用で休む'), '私用で休む')
  assert.equal(t('公僕として'), '公僕として')
  assert.equal(t('うちの会社では'), 'うちの会社では')
})

test('code, URLs, quotes and drafts are protected', () => {
  assert.equal(t('`私は` を使う'), '`私は` を使う')
  assert.equal(t('https://example.com/私は/x を見て'), 'https://example.com/私は/x を見て')
  assert.equal(t('彼は「私は行かない」と言った'), '彼は「私は行かない」と言った')
  assert.equal(t('> 私は本日休みます'), '> 私は本日休みます')
})

test('emoji are stripped when the persona uses none', () => {
  assert.equal(t('できた🎉'), 'できた')
})

test('streaming gives the same result as whole-text transform, at any split', () => {
  const text = '私はね、\n```js\nconst 私は = 1 // 私は\n```\nでも私が言いたいのは `私は` じゃなくて、私の話。\n最後に僕も'
  const whole = (() => { const s = new ToneStream(rules); return s.push(text) + s.end() })()
  for (let size = 1; size <= 7; size++) {
    const s = new ToneStream(rules)
    let out = ''
    for (let i = 0; i < text.length; i += size) out += s.push(text.slice(i, i + size))
    out += s.end()
    assert.equal(out, whole, `split size ${size}`)
  }
  assert.match(whole, /const 私は = 1 \/\/ 私は/)
  assert.match(whole, /`私は`/)
  assert.match(whole, /^あたしはね/)
  assert.match(whole, /あたしの話/)
})

async function collect(it) {
  const out = []
  for await (const c of it) out.push(c)
  return out
}

async function* fake(chunks) { for (const c of chunks) yield c }

test('rewriteStream keeps deltas and block-end consistent', async () => {
  const deltas = ['わた', 'しは今', '日も', '頑張っ', 'た🎉\n次', 'は私が']
  const original = deltas.join('')
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '私は考える' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '私は考える' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    ...deltas.map((d) => ({ type: 'text-delta', index: 1, text: d })),
    { type: 'block-end', index: 1, block: { type: 'text', text: original } },
    { type: 'block-start', index: 2, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 2, id: 'c1', name: 'bash', argumentsDelta: '{"cmd":"echo 私は"}' },
    { type: 'usage', usage: {} },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const out = await collect(rewriteStream(fake(chunks), rules))
  const text = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  const end = out.find((c) => c.type === 'block-end' && c.block.type === 'text')
  assert.equal(text, 'あたしは今日も頑張った\n次はあたしが')
  assert.equal(end.block.text, text)
  assert.equal(out.find((c) => c.type === 'reasoning-delta').text, '私は考える')
  assert.equal(out.find((c) => c.type === 'tool-call-delta').argumentsDelta, '{"cmd":"echo 私は"}')
  assert.equal(out.at(-1).type, 'finish')
})

test('rewriteStream passes through untouched with no rules', async () => {
  const chunks = [{ type: 'text-delta', index: 0, text: '私は' }, { type: 'finish', reason: { kind: 'stop' } }]
  const out = await collect(rewriteStream(fake(chunks), []))
  assert.deepEqual(out, chunks)
})

test('drift detection', () => {
  assert.deepEqual(driftIssues('あたしがやっといた。確認しといて。テストも通ってるから。', persona, 'business'), [])
  const issues = driftIssues('私が修正しました。確認をお願いします。他に何かお手伝いできることはありますか。テストも追加しました。', persona, 'business')
  assert.ok(issues.some((x) => x.includes('一人称')))
  assert.ok(issues.some((x) => x.includes('丁寧語')))
  assert.ok(issues.some((x) => x.includes('定型')))
})
