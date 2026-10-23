// Local persistence: every file lives under <DSH_HOME>/persona-core (or a configured dir).
// Writes are atomic (tmp + rename) and private (0600) because the data is personal.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, appendFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

/** Resolve the plugin data directory with the same precedence DSH uses for its home. */
export function resolveDataDir(configured) {
  if (configured && configured.trim()) return expandHome(configured.trim())
  const envHome = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  const home = envHome ? expandHome(envHome) : join(homedir(), '.dsh')
  return join(home, 'persona-core')
}

function expandHome(p) {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

export function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return structuredClone(fallback)
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return structuredClone(fallback)
  }
}

export function writeJsonAtomic(file, value) {
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
  try { chmodSync(file, 0o600) } catch { /* best effort on non-POSIX */ }
}

export function readText(file) {
  try { return readFileSync(file, 'utf8') } catch { return undefined }
}

export function writeTextIfMissing(file, text) {
  if (existsSync(file)) return false
  ensureDir(dirname(file))
  writeFileSync(file, text, { mode: 0o600 })
  return true
}

export function readJsonl(file) {
  const text = readText(file)
  if (!text) return []
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* skip a torn line */ }
  }
  return out
}

export function appendJsonl(file, value) {
  ensureDir(dirname(file))
  appendFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 })
}

export function writeJsonl(file, values) {
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, values.map((v) => JSON.stringify(v)).join('\n') + (values.length ? '\n' : ''), { mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * A JSON document kept in memory and flushed with a short debounce,
 * so frequent state updates do not hammer the disk.
 */
export class JsonDoc {
  constructor(file, fallback, delayMs = 500) {
    this.file = file
    this.data = readJson(file, fallback)
    this.delayMs = delayMs
    this.timer = undefined
  }

  save() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.delayMs)
    this.timer.unref?.()
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    try { writeJsonAtomic(this.file, this.data) } catch { /* persistence must never break the agent */ }
  }
}
