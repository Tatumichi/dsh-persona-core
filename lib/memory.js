// Long-term memory (F-M1..F-M10): user facts, relationship moments, her own
// self-consistent facts, and open threads to pick up later (F-H4).

import { randomUUID } from 'node:crypto'

export const KINDS = ['user', 'relation', 'self', 'thread']

const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /((?:password|passwd|pwd|パスワード|api[_ -]?key|token|secret|シークレット)\s*[:=：]\s*)\S+/gi,
  /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
]

/** Mask anything that looks like a credential before it is stored (F-M8). */
export function maskSecrets(text) {
  let out = String(text ?? '')
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, p1) => (typeof p1 === 'string' && m.startsWith(p1) ? `${p1}[伏せ字]` : '[伏せ字]'))
  return out
}

export function makeMemory({ kind, text, tags = [], importance = 0.5, pinned = false, now = Date.now() }) {
  return {
    id: randomUUID(),
    kind: KINDS.includes(kind) ? kind : 'user',
    text: maskSecrets(text).slice(0, 400),
    tags: tags.map(String).slice(0, 8),
    importance: Math.min(1, Math.max(0, Number(importance) || 0.5)),
    pinned: !!pinned,
    createdAt: now,
    lastUsedAt: undefined,
    resolved: false,
  }
}

/** Character bigrams — a dependency-free similarity that works for Japanese and English. */
function grams(s) {
  const t = String(s ?? '').toLowerCase().replace(/\s+/g, ' ')
  const out = new Set()
  const chars = [...t]
  for (let i = 0; i < chars.length - 1; i++) {
    const g = chars[i] + chars[i + 1]
    if (/^[\s、。,.!?！？]+$/.test(g)) continue
    out.add(g)
  }
  return out
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0
  let hit = 0
  for (const g of a) if (b.has(g)) hit++
  return hit / Math.sqrt(a.size * b.size)
}

const DAY = 86_400_000

/**
 * Pick the memories worth bringing into this reply.
 * Pinned always; then relevance x importance x recency.
 */
export function recall(memories, query, { limit = 8, now = Date.now(), includePersonal = true } = {}) {
  const q = grams(query)
  const live = memories.filter((m) => !(m.kind === 'thread' && m.resolved))
  const allowed = includePersonal ? live : live.filter((m) => m.kind === 'user' && !m.tags.includes('personal'))
  const pinned = allowed.filter((m) => m.pinned)
  const scored = allowed
    .filter((m) => !m.pinned && m.kind !== 'self')
    .map((m) => {
      const ageDays = (now - m.createdAt) / DAY
      const recency = Math.pow(0.5, ageDays / 60)
      const rel = overlap(q, grams(m.text + ' ' + m.tags.join(' ')))
      return { m, score: rel * 2 + m.importance * 0.6 + recency * 0.3 }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit - pinned.length))
    .map((x) => x.m)
  return [...pinned, ...scored]
}

/** Her own settled facts (F-M6 / F-P12): always injected, they are who she is. */
export function selfFacts(memories, limit = 20) {
  return memories.filter((m) => m.kind === 'self').slice(-limit)
}

/** Open threads to pick up next time (F-H4). */
export function openThreads(memories, limit = 3) {
  return memories.filter((m) => m.kind === 'thread' && !m.resolved).slice(-limit)
}

/** Older memories come back hazier (F-H5). */
export function isHazy(m, now = Date.now()) {
  return m.kind !== 'self' && now - m.createdAt > 45 * DAY
}

/** Drop near-duplicates of what is already stored. */
export function isDuplicate(memories, text) {
  const g = grams(text)
  return memories.some((m) => overlap(g, grams(m.text)) > 0.8)
}

export const DISTILL_SYSTEM = `あなたは会話ログから「記憶」を抽出する記録係です。出力は JSON のみ。前置き・説明・コードフェンスは書かない。`

/** Build the distillation prompt for a batch of exchanges. */
export function distillPrompt({ exchanges, existing, persona }) {
  const ex = exchanges.map((e, i) => `[${i + 1}] ユーザー: ${clip(e.user, 800)}\n[${i + 1}] キャラクター: ${clip(e.assistant, 800)}`).join('\n\n')
  const known = existing.slice(-40).map((m) => `- (${m.kind}) ${m.text}`).join('\n') || '（なし）'
  return `以下は、ユーザーと、あるキャラクター（一人称「${persona.firstPerson}」）との最近の会話です。

# 既に記録済みの記憶
${known}

# 最近の会話
${ex}

# 抽出ルール
- user: ユーザー本人についての、今後も役立つ事実・好み・状況（例: 名前、呼ばれたい名前、仕事内容、好きなもの、苦手なもの、生活リズム）
- relation: 二人の関係に関わる出来事（例: 初めて褒められた、喧嘩して仲直りした、内輪ネタ、呼び方の変化）
- self: キャラクターが自分自身について新しく語って確定したこと（好きなもの、趣味、癖など）。キャラクターの発言に根拠があるものだけ
- thread: 未解決のまま終わった作業や話題で、次回キャラクターから聞くと自然なもの（例: 調査中のバグ、明日の面接）
- resolved_threads: 既存の thread のうち、この会話で解決したものの本文（そのまま）
- 一時的な作業の詳細（コード断片、ファイル内容、コマンド出力）は記憶しない
- API キー・パスワード・トークンなどの秘密情報は絶対に記録しない
- 既に記録済みの内容と同じものは出さない
- ユーザーの呼び名がわかった場合は user_name に入れる

# 関係の変化
この会話を通じた関係の変化を -0.05〜+0.05 で評価する（普段どおりなら 0）。
- intimacy: 親しさ（雑談に付き合ってくれた、打ち明け話をした → 上がる）
- trust: 信頼（約束を守った、感謝された、誠実なやりとり → 上がる / 無視・暴言 → 下がる）

# 出力形式
{"memories":[{"kind":"user|relation|self|thread","text":"一文で","tags":["..."],"importance":0.0-1.0}],"resolved_threads":["..."],"user_name":null,"intimacy":0,"trust":0}`
}

function clip(s, n) {
  const t = String(s ?? '')
  return t.length > n ? t.slice(0, n) + '…' : t
}

/** Parse the distiller's JSON defensively. */
export function parseDistill(text) {
  const raw = extractJson(text)
  if (!raw || typeof raw !== 'object') return undefined
  const clampD = (v) => Math.max(-0.05, Math.min(0.05, Number(v) || 0))
  return {
    memories: Array.isArray(raw.memories) ? raw.memories.filter((m) => m && typeof m.text === 'string' && m.text.trim()) : [],
    resolvedThreads: Array.isArray(raw.resolved_threads) ? raw.resolved_threads.map(String) : [],
    userName: typeof raw.user_name === 'string' && raw.user_name.trim() ? raw.user_name.trim().slice(0, 30) : undefined,
    intimacy: clampD(raw.intimacy),
    trust: clampD(raw.trust),
  }
}

export function extractJson(text) {
  const t = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  try { return JSON.parse(t) } catch { /* fall through */ }
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)) } catch { /* ignore */ }
  }
  return undefined
}
