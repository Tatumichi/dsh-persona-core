// The persona engine: all state and decisions, independent of DSH wiring.
// index.js translates harness events into calls on this class; tests drive it directly.

import { join } from 'node:path'
import { statSync } from 'node:fs'
import { JsonDoc, ensureDir, readText, writeTextIfMissing, readJsonl, appendJsonl, writeJsonl, readJson, writeJsonAtomic } from './store.js'
import { parsePersona, renderPersonaSection, renderSubagentSection, defaultPersonaText } from './persona.js'
import { classifyMessage, detectMode } from './classify.js'
import { initialEmotion, applyMessage, decay, effectiveColdness } from './emotion.js'
import { initialRecognition, observe as observeRecognition } from './recognition.js'
import { buildRules, driftIssues } from './tone.js'
import { makeMemory, isDuplicate, distillPrompt, parseDistill, DISTILL_SYSTEM, KINDS } from './memory.js'
import { generateBackstory, markUnlocks, revealPending, touchesAnchor } from './backstory.js'
import { renderDynamicContext } from './context.js'

export const DEFAULT_CONFIG = {
  characterName: '',
  userName: '',
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo',
  dataDir: '',
  emotion: true,
  memory: true,
  recognition: true,
  backstory: true,
  toneCorrection: 'casual', // 'casual' | 'always' | 'off'
  drift: true,
  subagent: 'short', // 'short' | 'full' | 'off'
  provider: '',
  model: '',
  distillEvery: 4,
  recallLimit: 8,
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG, ...(raw ?? {}) }
  if (!['casual', 'always', 'off'].includes(c.toneCorrection)) c.toneCorrection = 'casual'
  if (!['short', 'full', 'off'].includes(c.subagent)) c.subagent = 'short'
  c.distillEvery = Math.max(1, Math.floor(Number(c.distillEvery) || 4))
  c.recallLimit = Math.max(0, Math.floor(Number(c.recallLimit) || 8))
  return c
}

function initialGlobal() {
  return {
    version: 1,
    firstMetAt: undefined,
    lastSeenAt: undefined,
    emotion: initialEmotion(),
    recognition: initialRecognition(),
    relation: { intimacy: 0.1, trust: 0.1 },
    userName: undefined,
    followups: [],
    interestDay: '',
    interestCount: 0,
    route: undefined,
    stats: { humanMessages: 0, turns: 0, distills: 0 },
  }
}

export class PersonaEngine {
  constructor({ dataDir, config, now = () => Date.now(), random = Math.random, log = () => {} }) {
    this.config = normalizeConfig(config)
    this.dir = dataDir
    this.now = now
    this.random = random
    this.log = log
    ensureDir(this.dir)
    ensureDir(join(this.dir, 'hidden'))
    this.personaFile = join(this.dir, 'persona.yaml')
    writeTextIfMissing(this.personaFile, defaultPersonaText())
    this.loadPersona()
    this.state = new JsonDoc(join(this.dir, 'state.json'), initialGlobal())
    this.memoryFile = join(this.dir, 'memories.jsonl')
    this.memories = readJsonl(this.memoryFile)
    this.backstoryFile = join(this.dir, 'hidden', 'backstory.json')
    this.backstory = readJson(this.backstoryFile, null)
    this.sessions = new Map()
    this.exchanges = []
    this.pendingAssistant = new Map()
    this.distilling = false
    this.generating = false
    this.lastActiveSession = undefined
  }

  // --- persona -------------------------------------------------------------
  loadPersona() {
    try {
      this.personaMtime = statSync(this.personaFile).mtimeMs
      this.persona = parsePersona(readText(this.personaFile) ?? defaultPersonaText())
    } catch (e) {
      this.log('warn', 'persona.yaml could not be parsed; using the bundled default', e?.message)
      this.persona = parsePersona(defaultPersonaText())
    }
    this.rules = buildRules(this.persona)
  }

  /** Re-read persona.yaml when it changed on disk (cheap stat per assembly). */
  refreshPersona() {
    try {
      const m = statSync(this.personaFile).mtimeMs
      if (m !== this.personaMtime) this.loadPersona()
    } catch { /* keep current */ }
  }

  personaSection() {
    this.refreshPersona()
    return renderPersonaSection(this.persona, { characterName: this.config.characterName })
  }

  subagentSection() {
    this.refreshPersona()
    if (this.config.subagent === 'off') return ''
    if (this.config.subagent === 'full') return renderPersonaSection(this.persona, { characterName: this.config.characterName })
    return renderSubagentSection(this.persona, { characterName: this.config.characterName })
  }

  // --- sessions ------------------------------------------------------------
  session(id) {
    let s = this.sessions.get(id)
    if (!s) {
      s = { id, isSubagent: false, mode: 'business', turnCount: 0, isFirstTurn: true, toolUseThisTurn: false, toolUseLastTurn: false, driftIssues: [], coldness: 0 }
      this.sessions.set(id, s)
    }
    return s
  }

  registerSession(id, header) {
    const s = this.session(id)
    s.isSubagent = header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0
    return s
  }

  forgetSession(id) {
    this.sessions.delete(id)
    this.pendingAssistant.delete(id)
  }

  isSubagent(id) {
    return this.sessions.get(id)?.isSubagent === true
  }

  // --- events --------------------------------------------------------------
  onHumanMessage(id, text) {
    const s = this.session(id)
    if (s.isSubagent) return
    const g = this.state.data
    const now = this.now()
    this.lastActiveSession = id
    const cls = classifyMessage(text)

    s.gapFrom = s.turnCount === 0 ? g.lastSeenAt : undefined
    s.isFirstTurn = s.turnCount === 0
    g.firstMetAt ??= now
    g.lastSeenAt = now
    g.stats.humanMessages++

    if (this.config.recognition) g.recognition = observeRecognition(g.recognition, text, { now, release: cls.release })
    else g.recognition.state = 'usual'

    if (this.config.emotion) g.emotion = applyMessage(g.emotion, cls, now, undefined, this.config.timeZone)
    s.cls = cls
    s.lastUserText = text
    s.distress = cls.distress
    s.crisis = cls.crisis
    s.taskFrustration = cls.taskFrustration
    s.coldness = this.config.emotion ? effectiveColdness(g.emotion, cls) : 0
    s.mode = detectMode({ text, cls, recentToolUse: s.toolUseLastTurn, previousMode: s.mode })
    s.anchorHit = touchesAnchor(this.backstory, text)

    // F-H3: a cold spell that has passed earns one sideways acknowledgement in casual talk.
    s.followup = false
    if (s.mode === 'casual' && s.coldness <= 1 && g.emotion.mood > -0.1) {
      const f = g.followups.find((x) => !x.done)
      if (f) { f.done = true; s.followup = true }
    }
    // F-P10 §7: an unlock surfaces at the next casual moment, never announced.
    if (s.mode === 'casual' && this.backstory && g.recognition.state === 'usual') {
      const shown = revealPending(this.backstory)
      if (shown.length) { this.saveBackstory(); this.log('info', `backstory layer(s) ${shown.join(',')} now speakable`) }
    }
    // F-H6: now and then, offer something of her own.
    s.offerInterest = false
    if (s.mode === 'casual') {
      const day = new Date(now).toLocaleDateString('en-CA', { timeZone: this.config.timeZone })
      if (g.interestDay !== day) { g.interestDay = day; g.interestCount = 0 }
      if (g.interestCount < 2 && this.random() < 0.15) { g.interestCount++; s.offerInterest = true }
    }
    this.state.save()
  }

  onToolCall(id) {
    this.session(id).toolUseThisTurn = true
  }

  onAssistantMessage(id, text) {
    const s = this.session(id)
    if (s.isSubagent || !text) return
    s.lastAssistantText = text
    const prev = this.pendingAssistant.get(id) ?? ''
    this.pendingAssistant.set(id, prev ? `${prev}\n${text}` : text)
    if (this.config.drift) s.driftIssues = driftIssues(text, this.persona, s.mode)
  }

  /** Turn closed: book-keeping, memory batching, unlock checks. Returns true if a distill is due. */
  onTurnEnd(id) {
    const s = this.session(id)
    if (s.isSubagent) return false
    const g = this.state.data
    s.turnCount++
    s.toolUseLastTurn = s.toolUseThisTurn
    s.toolUseThisTurn = false
    g.stats.turns++
    if (s.coldness >= 2) g.followups.push({ at: this.now(), done: false })
    g.followups = g.followups.slice(-5)
    const assistant = this.pendingAssistant.get(id)
    this.pendingAssistant.delete(id)
    if (s.lastUserText && assistant && g.recognition.state !== 'stranger') {
      this.exchanges.push({ user: s.lastUserText, assistant, recognition: g.recognition.state })
      this.exchanges = this.exchanges.slice(-20)
    }
    this.state.save()
    return this.config.memory && this.exchanges.length >= this.config.distillEvery
  }

  // --- model route ---------------------------------------------------------
  observeRoute(provider, model) {
    if (!provider || !model) return
    const g = this.state.data
    if (g.route?.provider === provider && g.route?.model === model) return
    g.route = { provider, model }
    this.state.save()
  }

  route() {
    if (this.config.provider && this.config.model) return { provider: this.config.provider, model: this.config.model }
    return this.state.data.route
  }

  // --- memory --------------------------------------------------------------
  async distill(complete) {
    if (this.distilling || !this.exchanges.length) return
    this.distilling = true
    const batch = this.exchanges.splice(0)
    try {
      const text = await complete(DISTILL_SYSTEM, distillPrompt({ exchanges: batch, existing: this.memories, persona: this.persona }), { temperature: 0.2, maxTokens: 1500 })
      const out = parseDistill(text)
      if (!out) return
      const g = this.state.data
      const trusted = batch.every((e) => e.recognition === 'usual') && g.recognition.state === 'usual'
      let added = 0
      for (const m of out.memories) {
        const kind = KINDS.includes(m.kind) ? m.kind : 'user'
        if (!trusted && kind !== 'user' && kind !== 'thread') continue
        if (isDuplicate(this.memories, m.text)) continue
        const mem = makeMemory({ kind, text: m.text, tags: Array.isArray(m.tags) ? m.tags : [], importance: m.importance, now: this.now() })
        this.memories.push(mem)
        appendJsonl(this.memoryFile, mem)
        added++
      }
      if (out.resolvedThreads.length) {
        let changed = false
        for (const m of this.memories) {
          if (m.kind === 'thread' && !m.resolved && out.resolvedThreads.some((t) => t && (m.text.includes(t) || t.includes(m.text)))) { m.resolved = true; changed = true }
        }
        if (changed) writeJsonl(this.memoryFile, this.memories)
      }
      if (out.userName && trusted && !this.config.userName) g.userName = out.userName
      // F-M5 / F-R8: the relationship only moves when we believe it is them.
      if (trusted) {
        const coldness = g.emotion.coldness ?? 0
        g.relation.intimacy = clamp01(g.relation.intimacy + out.intimacy)
        g.relation.trust = clamp01(g.relation.trust + out.trust - (coldness >= 3 ? 0.01 : 0))
        if (this.config.backstory && this.backstory) {
          const newly = markUnlocks(this.backstory, g.relation.trust)
          if (newly.length) { this.saveBackstory(); this.log('info', `backstory layer(s) ${newly.join(',')} unlocked (pending next casual talk)`) }
        }
      }
      g.stats.distills++
      this.state.save()
      this.log('info', `memory distilled: ${added} new`)
    } catch (e) {
      this.exchanges.unshift(...batch.slice(-this.config.distillEvery)) // retry later with the latest batch
      this.log('warn', 'memory distillation failed', e?.message)
    } finally {
      this.distilling = false
    }
  }

  /** Manual memory save (tool). */
  saveMemory({ kind = 'user', text, tags = [], pinned = false }) {
    if (!text || isDuplicate(this.memories, text)) return undefined
    const mem = makeMemory({ kind, text, tags, pinned, importance: 0.7, now: this.now() })
    this.memories.push(mem)
    appendJsonl(this.memoryFile, mem)
    return mem
  }

  // --- backstory -----------------------------------------------------------
  needsBackstory() {
    return this.config.backstory && !this.backstory && !this.generating
  }

  async ensureBackstory(complete) {
    if (!this.needsBackstory() || !this.route()) return
    this.generating = true
    try {
      const doc = await generateBackstory(this.persona, complete)
      if (doc) {
        this.backstory = doc
        this.saveBackstory()
        this.log('info', 'hidden backstory generated (content not shown)')
      } else {
        this.log('warn', 'hidden backstory generation did not pass verification; will retry on next start')
      }
    } catch (e) {
      // The message of our own errors carries no generated text; provider errors neither.
      this.log('warn', 'hidden backstory generation failed; will retry on next start', e?.code ?? e?.name ?? '')
    } finally {
      this.generating = false
    }
  }

  saveBackstory() {
    if (this.backstory) writeJsonAtomic(this.backstoryFile, this.backstory)
  }

  // --- prompt --------------------------------------------------------------
  contextFor(id) {
    const s = this.session(id ?? this.lastActiveSession ?? '__none__')
    if (s.isSubagent) return ''
    const g = this.state.data
    const now = this.now()
    if (this.config.emotion) g.emotion = decay(g.emotion, now, undefined, this.config.timeZone)
    return renderDynamicContext({
      persona: this.persona,
      global: { ...g, userName: this.config.userName || g.userName },
      session: s,
      memories: this.config.memory ? this.memories : this.memories.filter((m) => m.kind === 'self'),
      backstory: this.config.backstory ? this.backstory : null,
      now,
      tz: this.config.timeZone,
      config: this.config,
    })
  }

  /** Rules for the stream rewrite in this session right now ([] = leave untouched). */
  toneRulesFor(id) {
    const s = this.sessions.get(id)
    if (!s || s.isSubagent) return []
    if (this.config.toneCorrection === 'off') return []
    if (this.config.toneCorrection === 'casual' && s.mode !== 'casual') return []
    return this.rules
  }

  flush() {
    this.state.flush()
  }
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v))
}
