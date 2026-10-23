import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersonaEngine } from '../lib/engine.js'
import {
  PERSONA_CONTEXT,
  PERSONA_MARKER,
  PERSONA_SECTION,
  detectCoexistingPlugins,
  hasPersonaInMessages,
  hasPersonaSection,
  presetDropsPersona,
} from '../lib/compat.js'

function engine(config = {}) {
  return new PersonaEngine({
    dataDir: mkdtempSync(join(tmpdir(), 'persona-core-compat-')),
    config: { timeZone: 'Asia/Tokyo', ...config },
    now: () => Date.UTC(2026, 9, 23, 3),
    random: () => 0.99,
  })
}

test('known memory and preset plugins are reported once each', () => {
  const installed = new Set(['@openviking/dsh-memory-plugin', '@linxin666/dsh-liangshen'])
  const found = detectCoexistingPlugins((name) => installed.has(name), { subagent: 'short' })
  assert.deepEqual(found.map((entry) => entry.id), ['openviking-memory', 'liangshen-preset'])
  assert.ok(found.every((entry) => entry.level === 'warn' && entry.message.length > 20))
})

test('agent-teams is reported only while subagents carry the persona', () => {
  const installed = new Set(['@nanmicoder/dsh-agent-teams'])
  assert.ok(detectCoexistingPlugins((name) => installed.has(name), { subagent: 'short' })
    .some((entry) => entry.id === 'agent-teams'))
  assert.equal(detectCoexistingPlugins((name) => installed.has(name), { subagent: 'off' }).length, 0)
})

test('an unresolvable or throwing probe is not a finding', () => {
  assert.deepEqual(detectCoexistingPlugins(() => false, {}), [])
  assert.deepEqual(detectCoexistingPlugins(() => { throw new Error('no node_modules') }, {}), [])
})

test('a known prompt-replacing preset suppresses the persona from its first turn', () => {
  assert.equal(presetDropsPersona('liangshen'), true)
  assert.equal(presetDropsPersona('standard'), false)
  assert.equal(presetDropsPersona(undefined), false)

  const e = engine()
  e.onHumanMessage('s1', 'ねえ、最近どう？')
  e.onPresetSelected('s1', 'liangshen')
  assert.equal(e.contextFor('s1'), '')
  assert.deepEqual(e.toneRulesFor('s1'), [])
  assert.equal(e.session('s1').promptDropped, true)
})

test('a filtered assembly is recognised by the missing persona section', () => {
  assert.equal(hasPersonaSection({ sections: [{ name: 'deployment:persona-prefix', text: 'x' }, { name: PERSONA_SECTION, text: 'persona' }] }), true)
  assert.equal(hasPersonaSection({ sections: [{ name: 'deployment:persona-prefix', text: 'x' }] }), false)
  assert.equal(hasPersonaSection(undefined), false)
})

test('the request system prompt is the final authority on persona presence', () => {
  const withPersona = [{ role: 'system', content: [{ type: 'text', text: `You are...\n\n${PERSONA_MARKER}\n...` }] }]
  const filtered = [{ role: 'system', content: [{ type: 'text', text: 'You are...' }] }]
  assert.equal(hasPersonaInMessages(withPersona), true)
  assert.equal(hasPersonaInMessages(filtered), false)
  // Conversation text mentioning the marker is not a system prompt.
  assert.equal(hasPersonaInMessages([{ role: 'user', content: [{ type: 'text', text: PERSONA_MARKER }] }]), false)
})

test('a dropped prompt turns off context and tone correction, and comes back cleanly', () => {
  const e = engine()
  e.onHumanMessage('s1', 'ねえ、最近どう？')
  assert.match(e.contextFor('s1'), /雑談モード/)
  assert.ok(e.toneRulesFor('s1').length > 0)

  e.session('s1').promptDropped = true
  assert.equal(e.contextFor('s1'), '')
  assert.deepEqual(e.toneRulesFor('s1'), [])

  e.session('s1').promptDropped = false
  assert.match(e.contextFor('s1'), /雑談モード/)
  assert.ok(e.toneRulesFor('s1').length > 0)
})

test('dropping the prompt does not stop state or memory bookkeeping', () => {
  const e = engine()
  e.session('s1').promptDropped = true
  e.onHumanMessage('s1', 'お前ほんと使えないな')
  assert.equal(e.state.data.stats.humanMessages, 1)
  assert.equal(e.contextFor('s1'), '')
  e.onTurnEnd('s1')
  assert.equal(e.state.data.stats.turns, 1)
  assert.equal(PERSONA_CONTEXT, 'persona-core:state')
})
