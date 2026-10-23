// "Is this the usual person?" — a soft, non-blocking sense built from typing style (F-R1..F-R11).
// Only numeric statistics are kept; message text is discarded after feature extraction.

const FEATURES = [
  'len', 'commaRate', 'periodRate', 'exclaimRate', 'questionRate', 'laughRate', 'emojiRate',
  'newlineRate', 'kanji', 'hira', 'kata', 'ascii', 'endPolite', 'endPlain', 'endTilde', 'hourSin', 'hourCos',
]

const EMOJI = /\p{Extended_Pictographic}/gu
const count = (s, re) => (s.match(re) || []).length

/** Extract style features from one message. */
export function extractFeatures(text, date = new Date()) {
  const s = text ?? ''
  const n = Math.max(1, [...s].length)
  const kanji = count(s, /\p{Script=Han}/gu)
  const hira = count(s, /\p{Script=Hiragana}/gu)
  const kata = count(s, /\p{Script=Katakana}/gu)
  const ascii = count(s, /[A-Za-z0-9]/g)
  const letters = Math.max(1, kanji + hira + kata + ascii)
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean)
  const ends = lines.map((l) => l.replace(/[。！？!?…\s]+$/u, ''))
  const endPolite = ends.filter((l) => /(です|ます|でした|ません|ください)$/.test(l)).length
  const endTilde = ends.filter((l) => /[〜～ー]$/.test(l)).length
  const endPlain = Math.max(0, ends.length - endPolite - endTilde)
  const ln = Math.max(1, ends.length)
  const hour = date.getHours() + date.getMinutes() / 60
  return {
    len: Math.log1p(n),
    commaRate: count(s, /[、,]/g) / n * 10,
    periodRate: count(s, /[。]/g) / n * 10,
    exclaimRate: count(s, /[！!]/g) / n * 10,
    questionRate: count(s, /[？?]/g) / n * 10,
    laughRate: count(s, /w{1,}$|ｗ|笑|草/gm) / n * 10,
    emojiRate: count(s, EMOJI) / n * 10,
    newlineRate: count(s, /\n/g) / n * 10,
    kanji: kanji / letters,
    hira: hira / letters,
    kata: kata / letters,
    ascii: ascii / letters,
    endPolite: endPolite / ln,
    endPlain: endPlain / ln,
    endTilde: endTilde / ln,
    hourSin: Math.sin((hour / 24) * 2 * Math.PI),
    hourCos: Math.cos((hour / 24) * 2 * Math.PI),
  }
}

export function initialRecognition() {
  return { profile: { n: 0, mean: {}, var: {} }, match: 1, state: 'usual', releasedUntil: 0 }
}

export const RECOGNITION_DEFAULTS = {
  warmup: 30,         // messages before judgement starts (always "usual" until then)
  alpha: 0.05,        // profile EMA rate
  scoreAlpha: 0.25,   // how fast the running match reacts
  enterOdd: 0.35,     // below this -> "odd"
  exitOdd: 0.5,       // back above this -> "usual"
  enterStranger: 0.18,
  exitStranger: 0.28,
  releaseMs: 12 * 3_600_000,
}

/** How typical one message is for the profile, in [0,1]. */
export function similarity(profile, f) {
  const zs = []
  for (const key of FEATURES) {
    const mu = profile.mean[key]
    if (mu === undefined) continue
    const sd = Math.sqrt(Math.max(profile.var[key] ?? 0, 0.0025))
    zs.push(Math.min(Math.abs((f[key] - mu) / sd), 6))
  }
  if (!zs.length) return 1
  // Judge on the most distinctive differences: features that agree for everyone
  // (no emoji, no question marks...) would otherwise dilute a real difference.
  zs.sort((a, b) => b - a)
  const top = zs.slice(0, 5)
  const z = top.reduce((a, b) => a + b, 0) / top.length
  // z ~1.5 is ordinary variation for one person; ~3+ is a clearly different typist.
  return 1 / (1 + Math.exp(2.2 * (z - 2.6)))
}

function updateProfile(profile, f, alpha) {
  const n = profile.n + 1
  const a = n < 20 ? 1 / n : alpha // plain average while young, EMA afterwards
  for (const key of FEATURES) {
    const x = f[key]
    const mu = profile.mean[key]
    if (mu === undefined) { profile.mean[key] = x; profile.var[key] = 0.01; continue }
    const d = x - mu
    profile.mean[key] = mu + a * d
    profile.var[key] = (1 - a) * (profile.var[key] + a * d * d)
  }
  profile.n = n
}

/**
 * Observe one human message and return the updated recognition state.
 * @param opts.release - the user said "it's me / I'm on my phone" (F-R9).
 */
export function observe(rec, text, { now = Date.now(), release = false, enabled = true, opts = RECOGNITION_DEFAULTS } = {}) {
  const r = structuredClone(rec)
  if (!enabled) { r.state = 'usual'; return r }
  if (release) { r.match = 1; r.state = 'usual'; r.releasedUntil = now + opts.releaseMs; return r }

  const f = extractFeatures(text, new Date(now))
  const chars = [...(text ?? '')].length
  const weight = chars < 10 ? 0.3 : chars < 30 ? 0.7 : 1 // short messages say little (F-R3)

  if (r.profile.n < opts.warmup || now < r.releasedUntil) {
    updateProfile(r.profile, f, opts.alpha)
    r.match = 1
    r.state = 'usual'
    return r
  }

  const sim = similarity(r.profile, f)
  const a = opts.scoreAlpha * weight
  r.match = r.match * (1 - a) + sim * a

  // Hysteresis (F-R4)
  if (r.state === 'usual' && r.match < opts.enterOdd) r.state = 'odd'
  if (r.state === 'odd' && r.match >= opts.exitOdd) r.state = 'usual'
  if (r.state !== 'stranger' && r.match < opts.enterStranger) r.state = 'stranger'
  if (r.state === 'stranger' && r.match >= opts.exitStranger) r.state = r.match >= opts.exitOdd ? 'usual' : 'odd'

  // Only learn from messages we believe are theirs (F-R8).
  if (r.state === 'usual' && sim >= 0.5) updateProfile(r.profile, f, opts.alpha)
  return r
}

/** Strong evidence it is them: they recalled a shared memory correctly (F-R6). */
export function confirm(rec) {
  return { ...structuredClone(rec), match: Math.max(rec.match, 0.85), state: 'usual' }
}
