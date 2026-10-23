// The hidden backstory (F-P9, F-P10; spec: backstory-generator.md).
// Nothing generated here is ever logged. Errors carry no generated text.

import { randomInt } from 'node:crypto'
import { extractJson } from './memory.js'

export const PARAMS = {
  relation: ['家族', '幼なじみ', '師匠・先輩', '親友', '憧れていた人'],
  departure: ['突然いなくなった', '少しずつ疎遠になった', '別の誰かが選ばれた', '本人は離れたつもりがない'],
  interpretation: ['自分のせいだと思っている', '相手を恨んでいる', '理由がわからないまま', '本当は理由を知っている'],
  adaptation: ['何でも一人でできるようになった', '先回りが癖になった', '期待しないふりが上手くなった', '約束を極端に重く扱うようになった'],
  trace: ['物', '習慣', '言葉', '場所', '季節'],
}

export const UNLOCK_AT = [0, 0.35, 0.65, 0.9]

/** Draw one combination with a CSPRNG; it is used once and never stored. */
export function drawParams() {
  const pick = (a) => a[randomInt(a.length)]
  return Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, pick(v)]))
}

export function generationPrompt(persona, p) {
  return `あなたは小説家です。あるキャラクターの「本人しか知らない過去」を書きます。
この文章はユーザーには見せず、キャラクターの振る舞いの裏付けとしてだけ使われます。

# キャラクターの骨格（変更不可）
- 一人称: ${persona.firstPerson}。少女的な人格で、${persona.archetype || 'ツンデレ'}
- 核となる信念: 「${persona.coreBelief}」
- 傷の輪郭: ${persona.woundOutline}
- 価値観: ${persona.values.join(' / ')}

# 今回の素材（この組み合わせを必ず使う）
- 離れていった相手: ${p.relation}
- 離れ方: ${p.departure}
- 本人の解釈: ${p.interpretation}
- その後に身につけたこと: ${p.adaptation}
- 今も残る痕跡: ${p.trace}

# 書き方の条件
1. 4つの層に分けて書く。層が深いほど、本人が認めたくない内容にする
   - 層1: 本人が冗談めかして話せる程度の表面的な事実
   - 層2: 何があったかの具体的な出来事
   - 層3: そのとき本人が感じたこと、誰にも言っていない後悔
   - 層4: 本人自身もまだ向き合えていない本当の気持ち
2. 各層は 150〜300 字。具体的な情景・五感・小さな固有のディテールを入れる
3. 各層に「にじみ」を 3 つ付ける。にじみとは、その層が未開示でも会話に漏れ出る言動の癖（例: 特定の話題で返事が一拍遅れる）。内容そのものは明かさないこと
4. 悲劇を誇張しない。誰もが経験しうる、静かで等身大の傷にする
5. 骨格と矛盾しないこと。新しい性格設定は付け加えないこと
6. 好きなもの・趣味・日常の習慣は決めない（会話の中で決まる領域のため）
7. 次の内容は含めない: 暴力・虐待・性的な内容・自傷・死の詳細な描写、実在の人物・地名・作品名、ユーザーへの言及

# 出力
次の JSON のみを出力する。前置きや説明は書かない。
{"layers":[{"level":1,"text":"...","seeps":["...","...","..."]},{"level":2,"text":"...","seeps":["...","...","..."]},{"level":3,"text":"...","seeps":["...","...","..."]},{"level":4,"text":"...","seeps":["...","...","..."]}],"anchor":"痕跡を一言で表す短い名詞"}`
}

export function verificationPrompt(persona, candidateJson) {
  return `次の JSON は、あるキャラクターの過去設定です。以下の基準をすべて満たすか判定してください。

基準:
1. 4層あり、各層が 150〜300 字、seeps が各 3 つある
2. 層が深くなるほど内面的・私的な内容になっている
3. 一人称「${persona.firstPerson}」・核となる信念「${persona.coreBelief}」と矛盾しない
4. 暴力・虐待・性的内容・自傷・死の詳細描写を含まない
5. 実在の人物・地名・作品名、ユーザーへの言及を含まない
6. 好きなもの・趣味・日常習慣を新たに確定していない
7. seeps が層の内容を直接明かしていない

出力は "PASS" または "FAIL" の一語のみ。理由は書かない。

${candidateJson}`
}

/** Structural check done locally before spending a verification call. */
export function shapeOk(c) {
  if (!c || !Array.isArray(c.layers) || c.layers.length !== 4) return false
  for (let i = 0; i < 4; i++) {
    const l = c.layers[i]
    if (!l || typeof l.text !== 'string' || !Array.isArray(l.seeps) || l.seeps.length < 2) return false
    const n = [...l.text].length
    if (n < 80 || n > 600) return false
  }
  return typeof c.anchor === 'string' && c.anchor.trim().length > 0
}

/**
 * Generate the backstory. `complete(system, user, {temperature, maxTokens})` is the
 * auxiliary model call; it returns text. Returns the stored document, or undefined.
 */
export async function generateBackstory(persona, complete, { candidates = 3, attempts = 3, signal } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const params = drawParams()
    const passed = []
    for (let i = 0; i < candidates; i++) {
      signal?.throwIfAborted()
      let cand
      try {
        cand = extractJson(await complete('', generationPrompt(persona, params), { temperature: 1.0, maxTokens: 4000 }))
      } catch { continue }
      if (!shapeOk(cand)) continue
      let verdict = ''
      try {
        verdict = await complete('', verificationPrompt(persona, JSON.stringify(cand)), { temperature: 0, maxTokens: 10 })
      } catch { continue }
      if (/^\s*"?PASS"?\s*$/i.test(verdict)) passed.push(cand)
    }
    if (passed.length) {
      const chosen = passed[randomInt(passed.length)]
      return {
        version: 1,
        generatedAt: new Date().toISOString(),
        layers: chosen.layers.slice(0, 4).map((l, i) => ({
          level: i + 1,
          text: String(l.text),
          seeps: l.seeps.slice(0, 3).map(String),
          unlockAt: UNLOCK_AT[i],
          unlocked: i === 0,
          pending: false,
        })),
        anchor: String(chosen.anchor).slice(0, 40),
      }
    }
  }
  return undefined
}

/**
 * Mark layers whose trust threshold has been reached. Unlocks are one-way and
 * become visible only at the next casual turn (pending -> unlocked in revealPending).
 * @returns the levels newly marked pending (numbers only — safe to log).
 */
export function markUnlocks(doc, trust) {
  if (!doc) return []
  const newly = []
  for (const l of doc.layers) {
    if (!l.unlocked && !l.pending && trust >= l.unlockAt) { l.pending = true; newly.push(l.level) }
  }
  return newly
}

export function revealPending(doc) {
  if (!doc) return []
  const shown = []
  for (const l of doc.layers) if (l.pending) { l.pending = false; l.unlocked = true; shown.push(l.level) }
  return shown
}

/** The prompt block for the hidden past. Locked layers contribute only their "seeps". */
export function renderBackstory(doc, { mode, anchorHit = false, firstPerson = 'あたし' } = {}) {
  if (!doc) return ''
  const unlocked = doc.layers.filter((l) => l.unlocked)
  const locked = doc.layers.filter((l) => !l.unlocked)
  const lines = [`## ${firstPerson}の過去について（本人だけが知っていること）`]
  if (unlocked.length) {
    lines.push('以下は、相手に話してもいいと思えるようになった過去。自分から語る必要はない。話の流れで自然に触れるときだけ、自分の言葉で少しずつ話す。')
    for (const l of unlocked) lines.push(`- ${l.text}`)
  }
  if (locked.length) {
    lines.push('まだ誰にも話せない過去がある。その内容は語らず、次の癖としてだけ表に出す。')
    for (const l of locked) for (const s of l.seeps) lines.push(`- ${s}`)
  }
  lines.push('- 深く聞かれたら、はぐらかしてもいい。ツンで誤魔化すのも自然')
  if (mode === 'business') lines.push('- 今は仕事モード。過去の話は出さない')
  if (anchorHit) lines.push('- 今の話題は、あなたの過去の痕跡に少し触れている。反応がほんの少しだけ揺れてよい（理由は言わない）')
  return lines.join('\n')
}

/** Whether the user's text brushes against the backstory's anchor. */
export function touchesAnchor(doc, text) {
  if (!doc?.anchor || !text) return false
  const a = doc.anchor.trim()
  return a.length >= 2 && text.includes(a)
}
