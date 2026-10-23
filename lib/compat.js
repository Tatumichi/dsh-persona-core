// Compatibility with the rest of a composed dsh profile.
//
// Two different plugins can each be correct alone and still collide:
//  - a memory plugin recalls past conversations while persona-core injects its
//    own memories, so the same history reaches the model twice;
//  - an agent preset may replace the system prompt with its own whitelist and
//    drop persona-core's section, leaving the dynamic context (mood, memories,
//    the hidden past) in a prompt that no longer defines the persona.
//
// This module keeps detection pure so it can be tested without dsh. The wiring
// in index.js decides what to do with each finding.

import { messageText } from './classify.js'

/** Stable names used by the prompt registry. */
export const PERSONA_SECTION = 'persona-core:persona'
export const PERSONA_CONTEXT = 'persona-core:state'

/** First line of renderPersonaSection(); stable across persona.yaml contents. */
export const PERSONA_MARKER = '# あなたという人格'

/**
 * Agent presets known to replace the system prompt with their own section
 * whitelist. Selecting one is a per-session fact, so suppression can start
 * before the first request instead of after it.
 */
export const PROMPT_REPLACING_PRESETS = new Set(['liangshen'])

/** Whether this preset id is known to drop persona-core's section. */
export function presetDropsPersona(preset) {
  return typeof preset === 'string' && PROMPT_REPLACING_PRESETS.has(preset)
}

/**
 * Known plugins whose behaviour overlaps with persona-core's.
 * `when` lets a finding depend on this profile's config.
 */
const KNOWN = [
  {
    pkg: '@openviking/dsh-memory-plugin',
    id: 'openviking-memory',
    level: 'warn',
    message: 'OpenViking memory is installed: it recalls past conversations every turn, and persona-core also injects its own memories. Keep one memory owner (set memory:false here, or turn off OpenViking recall) so the same history is not injected twice.',
  },
  {
    pkg: '@linxin666/dsh-liangshen',
    id: 'liangshen-preset',
    level: 'warn',
    message: 'LiangShen is installed: its agent preset replaces the system prompt with a whitelist and drops persona-core\'s section. Sessions using that preset are detected and continue without the persona context or tone rewrite; use a standard preset for the full persona.',
  },
  {
    pkg: '@nanmicoder/dsh-agent-teams',
    id: 'agent-teams',
    level: 'info',
    message: 'agent-teams is installed: team members are subagents, so they receive persona-core\'s short voice section. Set subagent:off if team output should not carry it.',
    when: (config) => config.subagent !== 'off',
  },
]

/**
 * Findings for the plugins installed in this profile.
 * @param isInstalled - (packageName) => boolean, resolved from the profile.
 * @param config - normalized persona-core config.
 * @returns {{id:string, level:'warn'|'info', message:string}[]}
 */
export function detectCoexistingPlugins(isInstalled, config = {}) {
  const found = []
  for (const entry of KNOWN) {
    if (entry.when && !entry.when(config)) continue
    let installed = false
    try { installed = isInstalled(entry.pkg) === true } catch { installed = false }
    if (installed) found.push({ id: entry.id, level: entry.level, message: entry.message })
  }
  return found
}

/**
 * Whether the assembled prompt still carries persona-core's section.
 * A preset that rewrites `sections` (for example LiangShen's whitelist) removes
 * it even though the plugin is mounted and healthy.
 * @param assembly - the value returned by the `system-prompt/assemble` waterfall.
 */
export function hasPersonaSection(assembly) {
  return Array.isArray(assembly?.sections)
    && assembly.sections.some((section) => section?.name === PERSONA_SECTION)
}

/**
 * Whether any system-role message in the request still contains the persona.
 * This is the backstop for the assembled prompt: whatever a preset did to the
 * section list, the request itself is the final truth.
 */
export function hasPersonaInMessages(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some((message) => message?.role === 'system'
    && messageText(message).includes(PERSONA_MARKER))
}
