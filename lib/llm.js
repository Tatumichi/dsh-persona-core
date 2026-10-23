// Auxiliary model calls (memory distillation, backstory generation) and
// recognition of the agent loop's own requests at the llm/stream waterfall.
// No runtime imports from @deepseek-ai/* packages: a second copy of those
// modules would not share their process-local identities.

import { randomUUID } from 'node:crypto'

/** Our own one-shot request objects, so the tone layer never touches them. */
const OWN_REQUESTS = new WeakSet()

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}

function userMessage(text) {
  return deepFreeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'persona-core' } })
}

/**
 * Heuristic for "this request was built by the agent loop for a conversation step":
 * loop requests carry the system prompt as the first history message, a session id,
 * and no auxiliary purpose. Titles, compaction and our own calls are excluded.
 */
export function looksLikeLoopRequest(options) {
  if (!options || OWN_REQUESTS.has(options)) return false
  if (options.purpose !== undefined || options.system !== undefined) return false
  if (!options.sessionId) return false
  const first = options.messages?.[0]
  return first?.role === 'system'
}

/**
 * Make a completion function bound to a route resolver.
 * @param ctx - Cordis context exposing ctx.llm
 * @param resolveRoute - () => { provider, model } | undefined
 */
export function makeCompleter(ctx, resolveRoute) {
  return async function complete(system, user, { temperature, maxTokens = 2000, signal, timeoutMs = 120_000 } = {}) {
    const route = resolveRoute()
    if (!route) throw new Error('persona-core: no model route available yet')
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('persona-core: auxiliary call timed out')), timeoutMs)
    timer.unref?.()
    const onAbort = () => ac.abort(signal.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      // Sampling controls belong to the prepared config: changing them after
      // preparation is rejected by the runtime.
      const call = await ctx.llm.prepareCall({
        provider: route.provider,
        model: route.model,
        maxTokens,
        ...(temperature !== undefined ? { temperature } : {}),
      }, ac.signal)
      const options = {
        ...call.config,
        messages: [userMessage(user)],
        ...(system ? { system } : {}),
        signal: ac.signal,
      }
      OWN_REQUESTS.add(options)
      let text = ''
      let finish
      for await (const chunk of call.stream(options)) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && !text) text = chunk.block.text ?? ''
        else if (chunk.type === 'finish') finish = chunk.reason
      }
      const kind = finish?.kind
      if (kind && kind !== 'stop' && kind !== 'length' && kind !== 'max-tokens') throw new Error(`persona-core: auxiliary call ended with ${kind}`)
      return text
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}
