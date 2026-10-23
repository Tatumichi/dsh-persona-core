// dsh-persona-core — one personalised character across every DSH conversation.
//
// Host-side Cordis plugin. Wiring only; the behaviour lives in engine.js.
//   system prompt  : a stable persona section (global, shadowed per agent)
//   runtime context: per-session dynamic state (mode, feelings, memories, time, hidden past)
//   session/event  : observes what the user says and what she answered
//   llm/stream     : narrow rule-based tone correction of her text
//   tools          : memory_recall / memory_save

import { appendFileSync } from 'node:fs'
import { resolveDataDir } from './store.js'
import { PersonaEngine, normalizeConfig } from './engine.js'
import { makeCompleter, looksLikeLoopRequest } from './llm.js'
import { rewriteStream } from './stream.js'
import { messageText, isHumanMessage } from './classify.js'
import { recall } from './memory.js'

export const name = 'persona-core'
export const inject = ['systemPrompt', 'llm']

const SECTION = 'persona-core:persona'
const CONTEXT = 'persona-core:state'
const SECTION_ORDER = 1 // right after the deployment persona prefix (0)
const CONTEXT_ORDER = 300 // after the first-party runtime contexts (100..210)

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = typeof ctx.logger === 'function' ? ctx.logger('persona-core') : undefined
  const debugFile = process.env.PERSONA_CORE_DEBUG_FILE
  const log = (level, ...args) => {
    try { (logger?.[level] ?? console[level === 'warn' ? 'warn' : 'log'])('[persona-core]', ...args) } catch { /* never throw from logging */ }
    if (debugFile) { try { appendFileSync(debugFile, `${new Date().toISOString()} ${level} ${args.join(' ')}\n`) } catch { /* ignore */ } }
  }

  const engine = new PersonaEngine({ dataDir: resolveDataDir(config.dataDir), config, log })
  const complete = makeCompleter(ctx, () => engine.route())

  // Background work must never block or break a turn. On shutdown we give it a few
  // seconds to finish (a headless run exits right after its only turn).
  const pending = new Set()
  const background = (label, fn) => {
    const p = Promise.resolve().then(fn).catch((e) => log('warn', `${label} failed`, e?.message))
    pending.add(p)
    p.finally(() => pending.delete(p))
  }
  ctx.effect(() => async () => {
    if (pending.size) await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 8000).unref?.())])
    engine.flush()
  }, 'persona-core.drain')
  const maybeBackstory = () => { if (engine.needsBackstory() && engine.route()) background('backstory', () => engine.ensureBackstory(complete)) }

  // --- prompt: global registrations (used when an agent was not seen at creation) ---
  ctx.effect(() => ctx.systemPrompt.section({ name: SECTION, order: SECTION_ORDER, text: () => engine.personaSection(), interpolate: false }), 'persona-core.section')
  ctx.effect(() => ctx.systemPrompt.context({ name: CONTEXT, order: CONTEXT_ORDER, text: () => safe(() => engine.contextFor(undefined)), interpolate: false }), 'persona-core.context')

  // --- per agent: bind the dynamic state to that agent's session ---
  ctx.on('agent/created', ({ agent }) => {
    try {
      const session = agent.session
      const id = sessionIdOf(session)
      const s = engine.registerSession(id, session?.header)
      const sp = agent.ctx?.systemPrompt
      if (!sp) return
      if (s.isSubagent) {
        agent.ctx.effect(() => sp.section({ name: SECTION, order: SECTION_ORDER, text: () => engine.subagentSection(), interpolate: false }), 'persona-core.subagent-section')
        agent.ctx.effect(() => sp.context({ name: CONTEXT, order: CONTEXT_ORDER, text: () => '', interpolate: false }), 'persona-core.subagent-context')
      } else {
        agent.ctx.effect(() => sp.context({ name: CONTEXT, order: CONTEXT_ORDER, text: () => safe(() => engine.contextFor(id)), interpolate: false }), 'persona-core.session-context')
      }
    } catch (e) {
      log('warn', 'could not bind persona to a new agent', e?.message)
    }
  })

  ctx.on('agent/disposed', (payload) => {
    try { engine.forgetSession(sessionIdOf(payload?.agent?.session)) } catch { /* ignore */ }
  })

  // --- observe the conversation ---
  // Human input is read at agent/pre-step, before the runtime context is refreshed for
  // the request, so this very reply already reflects the new mode and feelings.
  const seen = new Set()
  const humanIn = (id, msg) => {
    if (!isHumanMessage(msg) || !id) return
    if (msg.id) {
      if (seen.has(msg.id)) return
      seen.add(msg.id)
      if (seen.size > 500) seen.delete(seen.values().next().value)
    }
    engine.onHumanMessage(id, messageText(msg))
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision?.kind === 'enter') {
        const id = sessionIdOf(payload.agent?.session)
        if (id && !engine.sessions.has(id)) engine.registerSession(id, payload.agent?.session?.header)
        for (const m of decision.messages ?? []) humanIn(id, m)
      }
    } catch (e) {
      log('warn', 'pre-step handling failed', e?.message)
    }
    return decision
  })

  ctx.on('session/event', (session, event) => {
    try {
      const id = sessionIdOf(session)
      if (!engine.sessions.has(id)) engine.registerSession(id, session?.header)
      switch (event?.type) {
        case 'user/message':
          // Normally already handled at agent/pre-step; this catches entry points without it.
          humanIn(id, event.data)
          break
        case 'tool/call':
          engine.onToolCall(id)
          break
        case 'assistant/message':
          if (!event.data?.interrupted) engine.onAssistantMessage(id, messageText(event.data?.message))
          break
        case 'turn/end': {
          const due = engine.onTurnEnd(id)
          if (due && engine.route()) background('memory', () => engine.distill(complete))
          maybeBackstory()
          break
        }
      }
    } catch (e) {
      log('warn', 'event handling failed', e?.message)
    }
  })

  // --- output-side tone correction + learning the model route ---
  ctx.on('llm/stream', function (options, next) {
    const upstream = next()
    try {
      if (!looksLikeLoopRequest(options)) return upstream
      const id = options.sessionId
      if (!engine.isSubagent(id)) engine.observeRoute(options.provider, options.model)
      const rules = engine.toneRulesFor(id)
      return rules.length ? rewriteStream(upstream, rules) : upstream
    } catch {
      return upstream
    }
  })

  // --- tools (only when the tool registry is mounted) ---
  ctx.inject(['tools'], (tctx) => {
    tctx.effect(() => tctx.tools.register(recallTool(engine)), 'persona-core.memory_recall')
    tctx.effect(() => tctx.tools.register(saveTool(engine)), 'persona-core.memory_save')
  })

  maybeBackstory()
  log('info', `loaded (data: ${engine.dir.replace(process.env.HOME ?? '\u0000', '~')})`)
}

function sessionIdOf(session) {
  return session?.id ?? session?.header?.id
}

function safe(fn) {
  try { return fn() } catch { return '' }
}

const textOut = (_args, value) => [{ type: 'text', text: String(value) }]

function recallTool(engine) {
  return {
    name: 'memory_recall',
    description: 'Search your long-term memories about the user and your shared history. Use when the user refers to something from a past conversation that is not in the current context.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look for, in the user\'s words' } },
      required: ['query'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: textOut },
    async execute(args) {
      const personal = engine.state.data.recognition?.state === 'usual'
      const found = recall(engine.memories, String(args?.query ?? ''), { limit: 8, includePersonal: personal })
      if (!found.length) return '該当する記憶はない。'
      return found.map((m) => `- (${m.kind}) ${m.text}`).join('\n')
    },
  }
}

function saveTool(engine) {
  return {
    name: 'memory_save',
    description: 'Save one durable fact worth remembering across conversations (about the user, your relationship, or yourself). Never save secrets, credentials or transient work details.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['user', 'relation', 'self', 'thread'], description: 'user: about the user / relation: shared moments / self: settled facts about yourself / thread: unfinished topic to follow up' },
        text: { type: 'string', description: 'One sentence' },
        pinned: { type: 'boolean', description: 'Always keep in mind (use sparingly)' },
      },
      required: ['kind', 'text'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: textOut },
    async execute(args) {
      if (engine.state.data.recognition?.state === 'stranger' && args?.kind !== 'user') return '今は保存しない。'
      const mem = engine.saveMemory({ kind: args?.kind, text: String(args?.text ?? ''), pinned: !!args?.pinned })
      return mem ? '覚えた。' : 'もう覚えてる。'
    },
  }
}
