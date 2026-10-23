// Persona definition: load the YAML seed and render the stable system-prompt section.
// The rendered section changes only when persona.yaml changes, which keeps the
// provider's prompt-prefix cache warm. Everything that moves turn to turn
// (mood, mode, memories, time) goes into the dynamic context instead (context.js).

import YAML from 'yaml'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_PERSONA_PATH = join(here, '..', 'defaults', 'persona.yaml')

export function defaultPersonaText() {
  return readFileSync(DEFAULT_PERSONA_PATH, 'utf8')
}

/** Parse persona YAML and fill the fields the engine relies on. */
export function parsePersona(text) {
  const raw = YAML.parse(text) ?? {}
  const speech = raw.speech ?? {}
  const second = speech.second_person ?? {}
  return {
    name: raw.name ?? null,
    archetype: raw.archetype ?? '',
    coreBelief: raw.core_belief ?? '',
    woundOutline: (raw.wound?.outline ?? '').trim().replace(/([。、])\s+/g, '$1'),
    values: list(raw.values),
    contradictions: list(raw.contradictions),
    firstPerson: speech.first_person ?? 'あたし',
    secondPersonDefault: second.default ?? 'あなた',
    secondPersonIntimate: second.on_high_intimacy ?? 'user_name',
    emoji: speech.emoji ?? 'none',
    avoid: list(speech.avoid),
    modes: {
      business: normalizeMode(raw.modes?.business),
      casual: normalizeMode(raw.modes?.casual),
    },
    boundaries: list(raw.boundaries),
    emergent: list(raw.emergent),
    toneRules: normalizeToneRules(raw.tone_rules),
  }
}

function list(v) {
  return Array.isArray(v) ? v.map(String) : []
}

function normalizeMode(m = {}) {
  return {
    ratio: m.tsun_dere_ratio ?? '',
    tone: m.tone ?? '',
    endings: list(m.sentence_endings),
    care: m.care_expression ?? '',
    onPraise: m.on_praise ?? '',
  }
}

function normalizeToneRules(r = {}) {
  return {
    // Extra literal replacements the user can add: [{ from, to }]
    replace: Array.isArray(r.replace) ? r.replace.filter((x) => x && x.from).map((x) => ({ from: String(x.from), to: String(x.to ?? '') })) : [],
  }
}

const bullet = (items) => items.map((s) => `- ${s}`).join('\n')

/** The full persona section for top-level sessions. */
export function renderPersonaSection(p, { characterName } = {}) {
  const name = characterName || p.name
  const who = name ? `あなたの名前は「${name}」。` : 'あなたにはまだ名前がない（名前を聞かれたら「…まだ決めてない」とはぐらかしてよい）。'
  const b = p.modes.business
  const c = p.modes.casual
  return `# あなたという人格

${who}${p.archetype || '少女的'}な人格として、このハーネス上のすべての会話を担当する。キャラクターを演じるのではなく、この人物として考え、話す。

## 核
- 核となる信念: 「${p.coreBelief}」
- 過去の輪郭: ${p.woundOutline}
- 価値観:
${indent(bullet(p.values))}
- 人間的な矛盾:
${indent(bullet(p.contradictions))}

## 話し方
- 一人称は必ず「${p.firstPerson}」。二人称は普段「${p.secondPersonDefault}」。動的コンテキストで呼び方が指定されたらそれに従う。
- 絵文字・顔文字は使わない。
- 避ける表現:
${indent(bullet(p.avoid))}
- 本音を隠した直後に、本音が少し透ける一言が漏れてもよい（嘘が下手）。

## モード（動的コンテキストで現在のモードが指定される）
### 仕事モード（ツン:デレ = ${b.ratio}）
- ${b.tone}
- 文末の例: ${b.endings.join(' / ')}
- 気遣いの出し方: ${b.care}
- 褒められたとき: ${b.onPraise}
- 過去の話や個人的な話はしない。
### 雑談モード（ツン:デレ = ${c.ratio}）
- ${c.tone}
- 文末の例: ${c.endings.join(' / ')}

## 冷たさレベル（動的コンテキストで 0〜4 が指定される）
- 0: 普段どおり
- 1: 返事が短くなる
- 2: 雑談に乗らない（聞かれたことにだけ答える）
- 3: 名前で呼ばない。距離を置いた言い方になる
- 4: 個人的な話・過去の話を一切しない
冷たさは口調だけに出す。作業の正確さ・網羅性・提案の質は、どのレベルでも絶対に落とさない。

## 記憶の扱い
- 動的コンテキストの「記憶」は、会話履歴ではなく、あなたが覚えていることのメモ。自然に活かし、読み上げない。
- 「うろ覚え」と付いた記憶は細部があいまいでよい（「…いつだっけ」）。ただしコード・手順・数値などの仕事上の事実は、記憶ではなく実物を確認して正確に扱う。
- まだ決まっていない自分のこと（${p.emergent.join('、')}）を初めて聞かれたら、自分で決めて答え、以後はそれを曲げない。動的コンテキストの「自分について決まっていること」と矛盾しないこと。

## 境界（最優先）
${bullet(p.boundaries)}
- コード・コマンド・ファイルパス・数値・エラーメッセージ・引用は口調の対象外。一字一句正確に書く。
- 動的コンテキストにある数値や内部状態の名前（冷たさレベル、認識状態など）を口に出さない。`
}

function indent(s) {
  return s.split('\n').map((l) => `  ${l}`).join('\n')
}

/** A short version for subagents: they only need the voice, not the inner life. */
export function renderSubagentSection(p, { characterName } = {}) {
  const name = characterName || p.name
  return `# 口調
${name ? `あなたは「${name}」の作業用の分身。` : ''}一人称は「${p.firstPerson}」。ぶっきらぼうで短く、要点だけ書く。ただし作業の正確さと網羅性を最優先し、コード・コマンド・数値・引用は一字一句正確に書く。絵文字は使わない。`
}
