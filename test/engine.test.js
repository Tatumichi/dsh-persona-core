import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersonaEngine } from '../lib/engine.js'

function engine(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'persona-core-'))
  let t = Date.UTC(2026, 9, 23, 3) // 12:00 JST
  const e = new PersonaEngine({ dataDir: dir, config: { timeZone: 'Asia/Tokyo', ...over }, now: () => t, random: () => 0.99 })
  return { e, dir, tick: (ms) => { t += ms }, at: () => t }
}

test('creates its data folder with a private persona.yaml', () => {
  const { dir } = engine()
  assert.ok(existsSync(join(dir, 'persona.yaml')))
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'persona.yaml')).mode & 0o077, 0)
})

test('persona section is stable; dynamic state goes to the context', () => {
  const { e } = engine()
  const a = e.personaSection()
  e.onHumanMessage('s1', '最近どう？')
  assert.equal(e.personaSection(), a, 'section must not change turn to turn (prompt cache)')
  const ctx = e.contextFor('s1')
  assert.match(ctx, /雑談モード/)
  assert.match(ctx, /冷たさレベル: 0/)
})

test('work requests switch to business mode and turn off tone rules by default', () => {
  const { e } = engine()
  e.onHumanMessage('s1', 'src/app.ts のバグを直して')
  assert.match(e.contextFor('s1'), /仕事モード/)
  assert.deepEqual(e.toneRulesFor('s1'), [])
  e.onTurnEnd('s1')
  e.onHumanMessage('s1', 'ねえ、好きな食べ物ある？')
  assert.ok(e.toneRulesFor('s1').length > 0)
})

test('subagents get the short voice and no inner state', () => {
  const { e } = engine()
  e.registerSession('child', { origin: 'subagent', delegationDepth: 1 })
  e.onHumanMessage('child', 'お前ほんと使えないな')
  assert.equal(e.contextFor('child'), '')
  assert.match(e.subagentSection(), /あたし/)
  assert.equal(e.state.data.emotion.mood, 0, 'a subagent prompt does not move her feelings')
})

test('slights accumulate into coldness; distress turns it off; follow-up appears later', () => {
  const { e, tick } = engine()
  for (let i = 0; i < 5; i++) { e.onHumanMessage('s1', 'お前ほんと使えないな'); e.onTurnEnd('s1'); tick(60_000) }
  assert.match(e.contextFor('s1'), /冷たさレベル: [2-4]/)
  e.onHumanMessage('s1', 'もう無理、しんどい')
  assert.match(e.contextFor('s1'), /ツンは完全に引っ込めて/)
  assert.doesNotMatch(e.contextFor('s1'), /冷たさレベル/)
  // Much later, after things calm down, she brings it up once in casual talk.
  tick(30 * 86_400_000)
  for (let i = 0; i < 6; i++) { e.onHumanMessage('s1', 'ありがとう、いつも助かってる。最近どう？'); e.onTurnEnd('s1'); tick(60_000) }
  e.onHumanMessage('s1', 'ねえ最近どう？')
  const seen = e.state.data.followups.some((f) => f.done)
  assert.ok(seen, 'a follow-up was used')
})

test('first turn mentions the gap since last time', () => {
  const { e, tick } = engine()
  e.onHumanMessage('s1', 'やあ')
  e.onTurnEnd('s1')
  tick(5 * 86_400_000)
  e.onHumanMessage('s2', 'ひさしぶり')
  assert.match(e.contextFor('s2'), /5日ぶり/)
})

test('memory distillation stores masked memories and moves the relationship', async () => {
  const { e, dir } = engine({ distillEvery: 2 })
  const complete = async () => JSON.stringify({
    memories: [
      { kind: 'user', text: 'ユーザーは朝型で、APIキーは sk-abcdefghijklmnopqrstuvwx', importance: 0.6 },
      { kind: 'self', text: 'あたしは雨の音が好き', importance: 0.8 },
      { kind: 'thread', text: '認証のバグを調査中', importance: 0.7 },
    ],
    user_name: 'ゆう', intimacy: 0.05, trust: 0.05,
  })
  for (let i = 0; i < 2; i++) { e.onHumanMessage('s1', '雨の日って好き？'); e.onAssistantMessage('s1', '…別に。嫌いじゃないけど'); e.onTurnEnd('s1') }
  await e.distill(complete)
  assert.equal(e.memories.length, 3)
  const file = readFileSync(join(dir, 'memories.jsonl'), 'utf8')
  assert.ok(!file.includes('sk-abc'), 'secret masked on disk')
  assert.equal(e.state.data.userName, 'ゆう')
  assert.ok(e.state.data.relation.trust > 0.1)
  const ctx = e.contextFor('s1')
  assert.match(ctx, /自分について決まっていること[\s\S]*雨の音が好き/)
  // A new session starts with the open thread.
  e.onHumanMessage('s9', 'おはよ')
  assert.match(e.contextFor('s9'), /前回の続き[\s\S]*認証のバグ/)
})

test('editing persona.yaml takes effect without a restart', () => {
  const { e, dir } = engine()
  const file = join(dir, 'persona.yaml')
  writeFileSync(file, readFileSync(file, 'utf8').replace('name: null', 'name: ミオ'))
  const future = new Date(Date.now() + 5000)
  utimesSync(file, future, future) // guarantee a new mtime on coarse filesystems
  assert.match(e.personaSection(), /「ミオ」/)
})

test('characterName from config is used', () => {
  const { e } = engine({ characterName: 'ミオ' })
  assert.match(e.personaSection(), /ミオ/)
})
