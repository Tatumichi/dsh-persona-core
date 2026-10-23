// Feelings: a fast-moving mood and a slow-moving hurt (F-E1..F-E11),
// plus the daily baseline mood (F-H2).

const HOUR = 3_600_000
const DAY = 24 * HOUR

export const EMOTION_DEFAULTS = {
  moodHalfLifeMs: 3 * HOUR,
  hurtHalfLifeMs: 10 * DAY,
  dailyMoodSwing: 0.15,
}

export function initialEmotion(now = Date.now()) {
  return { mood: 0, hurt: 0, coldness: 0, updatedAt: now, lowSince: undefined }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** Deterministic small daily offset: same day, same baseline. */
export function dailyBaseline(date = new Date(), swing = EMOTION_DEFAULTS.dailyMoodSwing, tz = 'Asia/Tokyo') {
  const key = date.toLocaleDateString('en-CA', { timeZone: tz })
  let h = 2166136261
  for (const ch of key) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0 }
  const unit = (h % 10_000) / 10_000 // [0,1)
  return (unit * 2 - 1) * swing
}

/** Let time pass: mood drifts back to today's baseline, hurt fades very slowly. */
export function decay(e, now = Date.now(), opts = EMOTION_DEFAULTS, tz) {
  const dt = Math.max(0, now - (e.updatedAt ?? now))
  const base = dailyBaseline(new Date(now), opts.dailyMoodSwing, tz)
  const mk = Math.pow(0.5, dt / opts.moodHalfLifeMs)
  const hk = Math.pow(0.5, dt / opts.hurtHalfLifeMs)
  return { ...e, mood: base + (e.mood - base) * mk, hurt: e.hurt * hk, updatedAt: now }
}

/**
 * Apply one classified human message.
 * Distress and task frustration never count against the user.
 */
export function applyMessage(e, cls, now = Date.now(), opts = EMOTION_DEFAULTS, tz) {
  let s = decay(e, now, opts, tz)
  let { mood, hurt } = s
  const negative = cls.insult || cls.mock || cls.toolTreatment

  if (negative && !cls.distress && !cls.crisis) {
    if (cls.insult) mood -= 0.35
    if (cls.mock) mood -= 0.25
    if (cls.toolTreatment) mood -= 0.2
    // Hurt accumulates when a slight lands while she is already low,
    // and being treated as a mere tool cuts deeper (it touches her core belief).
    const lowFactor = mood < -0.3 ? 1 : 0.4
    hurt += (cls.insult ? 0.06 : 0) * lowFactor + (cls.mock ? 0.05 : 0) * lowFactor + (cls.toolTreatment ? 0.1 : 0) * lowFactor
  }
  if (cls.apology) { mood += 0.3; hurt -= 0.08 }
  if (cls.thanks) { mood += 0.15; hurt -= 0.02 }
  if (cls.care) { mood += 0.15; hurt -= 0.04 }
  if (cls.smalltalk && !negative) mood += 0.03

  mood = clamp(mood, -1, 1)
  hurt = clamp(hurt, 0, 1)
  const lowSince = mood < -0.4 ? (s.lowSince ?? now) : undefined
  // A sustained low mood also wears in, a little per message while it lasts.
  if (lowSince !== undefined && now - lowSince > 30 * 60_000) hurt = clamp(hurt + 0.01, 0, 1)

  const target = coldnessFor(mood, hurt)
  // Recovery is gradual (F-E10): coldness may rise at once but falls one level per message.
  const prev = s.coldness ?? 0
  const coldness = target < prev ? prev - 1 : target
  return { ...s, mood, hurt, coldness, lowSince }
}

/** Map feelings to the 0..4 coldness scale (F-E6, capped at 4 by F-E7). */
export function coldnessFor(mood, hurt) {
  const score = Math.max(0, -mood) * 0.6 + hurt * 0.8
  if (score >= 0.6) return 4
  if (score >= 0.45) return 3
  if (score >= 0.3) return 2
  if (score >= 0.15) return 1
  return 0
}

/** The coldness she actually shows right now. Distress switches it off (F-E11). */
export function effectiveColdness(e, cls) {
  if (cls?.distress || cls?.crisis) return 0
  return clamp(e.coldness ?? 0, 0, 4)
}

/** A human-readable mood word for the prompt (never a number). */
export function moodWord(mood) {
  if (mood >= 0.45) return '機嫌がいい（隠そうとしているが少し浮かれている）'
  if (mood >= 0.15) return 'やや機嫌がいい'
  if (mood > -0.15) return '普通'
  if (mood > -0.45) return '少しむっとしている'
  return 'かなり機嫌が悪い（静かに冷えている）'
}
