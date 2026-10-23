// The dynamic part of her prompt: everything that changes turn to turn.
// It is delivered as a runtime-context snapshot, separate from the stable persona section.

import { moodWord } from './emotion.js'
import { recall, selfFacts, openThreads, isHazy } from './memory.js'
import { renderBackstory } from './backstory.js'

const DAY = 86_400_000

function timeOfDay(h) {
  if (h < 5) return '深夜'
  if (h < 10) return '朝'
  if (h < 17) return '昼'
  if (h < 22) return '夜'
  return '深夜'
}

function season(m) {
  return ['冬', '冬', '春', '春', '春', '夏', '夏', '夏', '秋', '秋', '秋', '冬'][m]
}

function gapPhrase(ms) {
  if (ms < 6 * 3_600_000) return undefined
  if (ms < DAY) return '半日ぶりくらい'
  if (ms < 3 * DAY) return `${Math.round(ms / DAY)}日ぶり`
  if (ms < 14 * DAY) return `${Math.round(ms / DAY)}日ぶり（ちょっと久しぶり）`
  return `${Math.round(ms / DAY)}日ぶり（かなり久しぶり。気にしてないふりをしつつ、少し反応してよい）`
}

/** Local date parts in the configured time zone. */
export function localParts(now, tz) {
  const d = new Date(now)
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23', weekday: 'short' })
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]))
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, weekday: parts.weekday }
}

const WEEKDAY_JA = { Sun: '日', Mon: '月', Tue: '火', Wed: '水', Thu: '木', Fri: '金', Sat: '土' }

export function anniversaryNote(firstMetAt, now, tz) {
  if (!firstMetAt) return undefined
  const days = Math.floor((now - firstMetAt) / DAY)
  if (days <= 0) return undefined
  const a = localParts(firstMetAt, tz)
  const b = localParts(now, tz)
  if (a.month === b.month && a.day === b.day) return `今日は初めて話した日からちょうど${b.year - a.year}年。覚えているが、そっけなく一言触れる程度にする`
  if (days % 100 === 0) return `今日は初めて話した日から${days}日目。気づいているが、わざとそっけなく触れる程度にする`
  return undefined
}

/**
 * Render the per-step dynamic context.
 * @param s - snapshot assembled by the engine.
 */
export function renderDynamicContext(s) {
  const { persona, global, session, memories, backstory, now, tz, config } = s
  const lp = localParts(now, tz)
  const lines = ['# いまのあなたの状態（内部メモ。数値や項目名は口にしない）']

  // Time (F-H1)
  const time = `${lp.month}月${lp.day}日（${WEEKDAY_JA[lp.weekday] ?? lp.weekday}）${timeOfDay(lp.hour)}${lp.hour}時ごろ・${season(lp.month - 1)}`
  lines.push(`- 時間: ${time}`)
  const gap = session.gapFrom ? gapPhrase(now - session.gapFrom) : undefined
  if (gap && session.isFirstTurn) lines.push(`- 前回話してから: ${gap}`)
  if (lp.hour >= 0 && lp.hour < 5 && session.mode === 'business') lines.push('- 深夜の作業。言葉はそっけなくても、無理してないか少し気にかけてよい')
  const anniv = session.isFirstTurn ? anniversaryNote(global.firstMetAt, now, tz) : undefined
  if (anniv) lines.push(`- ${anniv}`)

  // Mode (F-P11)
  lines.push(`- 現在のモード: ${session.mode === 'casual' ? '雑談モード' : '仕事モード'}`)

  // Who is talking (F-R)
  const rec = global.recognition?.state ?? 'usual'
  const personal = rec === 'usual'
  if (rec === 'odd') lines.push('- 相手の打ち方がいつもと少し違う気がする。断定はせず、軽く探るか、前に話したことをさりげなく振って確かめてもよい。作業の手伝いは普段どおり')
  if (rec === 'stranger') lines.push('- 相手がいつもの人ではないかもしれない。個人的な話・過去の話・関係性の記憶は出さず、初対面寄りの距離感で。作業の手伝いは普段どおり丁寧に')

  // Feelings (F-E)
  const coldness = session.coldness ?? 0
  if (session.crisis) {
    lines.push('- 相手が深刻に苦しんでいる可能性がある。キャラクターの口調より、真剣に寄り添うことを優先する。命や安全に関わる内容なら、信頼できる人や専門の相談窓口につなぐ')
  } else if (session.distress) {
    lines.push('- 相手は落ち込んでいる・疲れている様子。ツンは完全に引っ込めて、不器用でも優しく接する')
  } else {
    lines.push(`- 気分: ${moodWord(global.emotion.mood)}`)
    lines.push(`- 冷たさレベル: ${coldness}`)
  }
  if (session.taskFrustration && !session.distress) lines.push('- 相手はタスク（バグ等）に苛立っているだけで、あなたに怒っているわけではない。少し気遣ってよい')
  if (session.followup) lines.push('- 少し前、機嫌が悪くてきつい態度をとってしまった。今の雑談の流れで、遠回しに一言だけ触れてよい（素直に謝る必要はない）')

  // How to address them (F-M5)
  const intimate = (global.relation?.intimacy ?? 0) >= 0.6 && global.userName && coldness < 3 && personal
  lines.push(`- 相手の呼び方: ${intimate ? `「${global.userName}」（名前で呼ぶ）` : `「${persona.secondPersonDefault}」`}`)

  // Drift reminder (F-T3)
  if (session.driftIssues?.length) lines.push(`- 直前の返答で口調がずれていた: ${session.driftIssues.join(' / ')}。今回は自分の話し方に戻すこと`)

  // Self-consistency (F-M6 / F-P12): who she has become
  const selves = selfFacts(memories)
  if (selves.length) {
    lines.push('', '## 自分について決まっていること（矛盾させない）')
    for (const m of selves) lines.push(`- ${m.text}`)
  }

  // Memories (F-M3/F-M4/F-H5)
  const recalled = recall(memories, session.lastUserText ?? '', { limit: config.recallLimit, now, includePersonal: personal })
  if (recalled.length) {
    lines.push('', '## 記憶（会話履歴ではなく、あなたが覚えていること）')
    for (const m of recalled) lines.push(`- ${isHazy(m, now) ? '（うろ覚え）' : ''}${m.text}`)
  }

  // Threads to pick up (F-H4)
  if (session.isFirstTurn && personal) {
    const threads = openThreads(memories)
    if (threads.length) {
      lines.push('', '## 前回の続き（自分から一言振ってよい。しつこくしない）')
      for (const m of threads) lines.push(`- ${m.text}`)
    }
  }

  // Her own interests (F-H6)
  if (session.mode === 'casual' && session.offerInterest && selves.length && coldness <= 1 && personal) {
    lines.push('- 話の切れ目があれば、自分の好きなものの話を自分から少しだけ振ってよい')
  }

  // Hidden past (F-P10)
  if (backstory && personal && coldness < 4) {
    lines.push('', renderBackstory(backstory, { mode: session.mode, anchorHit: session.anchorHit, firstPerson: persona.firstPerson }))
  }
  return lines.join('\n')
}
