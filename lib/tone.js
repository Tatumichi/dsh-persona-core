// Output-side tone correction (F-T1..F-T3).
// Layer B: a narrow, rule-based rewrite of natural-language text in the model stream.
// Layer C: a drift score computed after the reply, fed back as a reminder next step.
// Code fences, inline code and URLs are never touched.

const PARTICLE = '(?=[はがもをにのとでへやかっ、。！？!?…\\s」』）)]|自身|たち|達|から|まで|より|だけ|しか|って)'

/** Build the replacement rules from the persona. */
export function buildRules(persona, { stripEmoji = true } = {}) {
  const fp = persona.firstPerson || 'あたし'
  const rules = []
  // うち/ウチ are left alone on purpose: "うちの会社" usually means "our company".
  for (const other of ['私', 'わたし', 'わたくし', 'ワタシ', '僕', 'ぼく', 'ボク']) {
    if (other === fp) continue
    // Only when it stands as a pronoun: not glued to a preceding kanji/kana word
    // (keeps 公僕), and followed by a particle (keeps 私立, 私用, 私鉄).
    const lead = '(^|[^\\p{Script=Han}ぁ-ゖァ-ヺ]|は|も|が|て|で|ど|ら|ね|よ|し)'
    rules.push({ re: new RegExp(`${lead}${escape(other)}${PARTICLE}`, 'gu'), to: `$1${fp}` })
  }
  for (const { from, to } of persona.toneRules?.replace ?? []) {
    rules.push({ re: new RegExp(escape(from), 'gu'), to: to.replace(/\$/g, '$$$$') })
  }
  if (stripEmoji && persona.emoji === 'none') {
    rules.push({ re: /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]+/gu, to: '' })
  }
  return rules
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const URL_RE = /https?:\/\/[^\s)>\]」』]+/g

/** Apply rules to one line that is outside any code fence. Inline code and URLs are protected. */
export function transformLine(line, rules) {
  if (!rules.length || !line) return line
  const parts = []
  let last = 0
  // Quoted lines and 「」『』 spans are other people's words or drafts written for the user
  // (an email in 私-voice must stay 私): protect them along with code and URLs.
  if (/^\s*>/.test(line)) return line
  const protect = /`[^`]*`|https?:\/\/[^\s)>\]」』]+|「[^「」]*」|『[^『』]*』/g
  let m
  while ((m = protect.exec(line))) {
    parts.push({ text: line.slice(last, m.index), safe: false })
    parts.push({ text: m[0], safe: true })
    last = m.index + m[0].length
  }
  parts.push({ text: line.slice(last), safe: false })
  return parts.map((p) => (p.safe ? p.text : applyRules(p.text, rules))).join('')
}

function applyRules(text, rules) {
  let out = text
  for (const r of rules) out = out.replace(r.re, r.to)
  return out
}

/**
 * Streaming transformer for one text block.
 * Feed deltas with push(); it returns text that is safe to emit now.
 * Text is held back until a line ends (or a long line reaches a sentence end
 * outside inline code), so a pronoun split across deltas is still caught.
 */
export class ToneStream {
  constructor(rules, { maxHold = 240 } = {}) {
    this.rules = rules
    this.buf = ''
    this.inFence = false
    this.maxHold = maxHold
  }

  push(delta) {
    this.buf += delta
    let out = ''
    for (;;) {
      const nl = this.buf.indexOf('\n')
      if (nl >= 0) {
        out += this.line(this.buf.slice(0, nl)) + '\n'
        this.buf = this.buf.slice(nl + 1)
        continue
      }
      if (this.buf.length > this.maxHold && !this.inFence) {
        const cut = safeSentenceCut(this.buf)
        if (cut > 0) {
          out += transformLine(this.buf.slice(0, cut), this.rules)
          this.buf = this.buf.slice(cut)
          continue
        }
      }
      if (this.inFence && this.buf.length > this.maxHold && !/^\s*`{0,2}$/.test(this.buf)) {
        // Inside code nothing is rewritten, so long code lines can stream straight through
        // unless they might be the closing fence.
        out += this.buf
        this.buf = ''
      }
      break
    }
    return out
  }

  /** Flush whatever is held at block end. */
  end() {
    const rest = this.buf
    this.buf = ''
    if (!rest) return ''
    return this.inFence ? rest : this.line(rest)
  }

  line(l) {
    if (/^\s*(```|~~~)/.test(l)) { this.inFence = !this.inFence; return l }
    if (this.inFence) return l
    return transformLine(l, this.rules)
  }
}

/** Index just after the last 。！？ that is not inside an open inline-code span; 0 if none. */
function safeSentenceCut(s) {
  let ticks = 0
  let cut = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '`') ticks++
    else if ((c === '。' || c === '！' || c === '？') && ticks % 2 === 0) cut = i + 1
  }
  return cut
}

/** Plain text with fenced code, inline code and URLs removed — what tone is judged on. */
export function proseOnly(text) {
  return (text ?? '')
    .replace(/(^|\n)\s*(```|~~~)[\s\S]*?(\n\s*(```|~~~)|$)/g, '\n')
    .replace(/`[^`]*`/g, '')
    .replace(URL_RE, '')
}

/**
 * Layer C: how far the reply drifted from her voice. Returns problems found (empty = fine).
 */
export function driftIssues(text, persona, mode) {
  const prose = proseOnly(text)
  if ([...prose.trim()].length < 20) return []
  const issues = []
  const fp = persona.firstPerson || 'あたし'
  if (/(^|[^\p{Script=Han}])(私|わたし|僕)(は|が|も|の|に|を)/u.test(prose)) issues.push(`一人称が「${fp}」になっていない`)
  if (/\p{Extended_Pictographic}/u.test(prose)) issues.push('絵文字を使っている')
  if (/ですわ|ますわ|ですの[。！]/.test(prose)) issues.push('お嬢様言葉になっている')
  const sentences = prose.split(/[。！？!?\n]+/).map((s) => s.trim()).filter((s) => [...s].length >= 6)
  if (sentences.length >= 3) {
    const polite = sentences.filter((s) => /(です|ます|でした|ました|ません|ましょう|ください|ですか|ますか|ませんか)$/.test(s)).length
    const ratio = polite / sentences.length
    if (ratio >= 0.6) issues.push(mode === 'casual' ? '雑談なのに丁寧語が多すぎる' : '丁寧語が多すぎて、ぶっきらぼうさが消えている')
  }
  if (/(何か|なにか)(他に|ほかに)?(お手伝い|お役に立て)|お気軽にお申し付け|喜んで(お手伝い|対応)/.test(prose)) issues.push('アシスタント的な定型の締めを使っている')
  return issues
}
