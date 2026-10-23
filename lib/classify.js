// Rule-based reading of the user's message: what kind of moment is this?
// Rules are deliberately conservative — a missed slight is far cheaper than
// turning cold on someone who did nothing wrong.

/** Plain text of a message's text blocks. */
export function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}

/** Whether a user-role message was typed by the human (not injected context). */
export function isHumanMessage(message) {
  return message?.role === 'user' && message?.source?.kind === 'user'
}

const any = (text, patterns) => patterns.some((p) => p.test(text))

// --- addressed at her -------------------------------------------------------
const ADDRESSEE = [/お前|おまえ|てめ[えー]|あんた|貴様|きさま|君(?!が代)|きみ|こいつ|このAI|\bAI\b|\byou\b|\bu\b/i]
const INSULT = [
  /馬鹿|バカ(?!ンス)|ばか(?!り)|阿呆|アホ|あほ(?!う)|無能|役立たず|使えね[えー]|ポンコツ|ゴミ(?!箱|袋|出し|収集|ファイル)|クズ|カス(が|め|野郎)|うざ[いっ]|ウザ[いっ]|きもい|キモい|キモ[っッ]|きっしょ|黙れ|だまれ|消えろ|死ね/,
  /\b(stupid|idiot|useless|dumb|shut up|garbage|trash)\b/i,
]
// Words that are ordinary about a tool or API ("このAPIは使えない") and only sting when aimed at her.
const INSULT_IF_ADDRESSED = [/使えない|役に立たない|役に立たね|ダメだな|だめだな|期待外れ|がっかり/]
const MOCK =[/(笑|w{2,}|草).*(ざまあ|ダサ|だっさ)|ざまあ|プークスクス|ばーか/]
// Dismissive commanding — treating her as a mere tool. Plain imperatives are
// normal work requests and do NOT count; only these dismissive markers do.
const TOOL_TREATMENT = [
  /いいから(早く|さっさと|黙って|やれ|やって)/,
  /黙って(やれ|やって|従え|書け)/,
  /さっさと(しろ|やれ)/,
  /口答えするな|余計なこと(言うな|すんな|するな)|意見(は)?いらない|感想(は)?いらない/,
  /お前(は|なんて)?(ただの)?道具/,
  /\b(just do it|do as (i|you're) told|you're (just )?a tool)\b/i,
]

// --- warmth -----------------------------------------------------------------
const THANKS = [/ありがと|有難|有り難|感謝|助か(った|る|りました)|サンキュ|thx|thank/i, /(さすが|流石)|すごい|すげ[えー]|天才|偉い|えらい/]
const APOLOGY = [/ごめん|すまん|すみません|申し訳|悪かった|言い過ぎ|言いすぎ|\bsorry\b|my bad/i]
const CARE = [/大丈夫\?|大丈夫？|無理(しないで|すんな|しなくて)|疲れて(ない|る\?|る？)|おつかれ|お疲れ|休んで|元気\?|元気？/]
const SMALLTALK = [/(今日|最近|昨日|週末).*(どう|何し|なにし)|好きな|趣味|どう思う|どんな(気分|感じ)|雑談|話そう|話したい|聞いて(よ|ほしい)|ねえ|ねぇ/]

// --- the user's own state ---------------------------------------------------
const DISTRESS = [
  /しんどい|つらい|辛い|疲れた|もう無理|限界|泣きたい|泣いて|落ち込|へこ[んむ]|凹ん|眠れな|不安で|孤独|ひとりぼっち|寂し/,
  /\b(exhausted|depressed|burn(ed|t) out|can't (take|do) (it|this) anymore)\b/i,
]
const CRISIS = [/死にたい|消えたい|自殺|自傷|リスカ|生きて(いる|る)?意味|いなくなりたい|\b(kill myself|suicid|self[- ]harm)/i]
// Frustration aimed at the task, not at her.
const TASK_FRUSTRATION = [/動かない|動かん|通らない|落ちる|エラー|バグ|壊れ|なんで(だ|だよ|なん)|意味わからん|クソ(コード|仕様|API)|ふざけんな(この(コード|バグ|API))|ビルドが|テストが/]

// --- recognition release ----------------------------------------------------
const RELEASE = [/(今日|いま|今)は?(スマホ|携帯|タブレット|別の(端末|PC|パソコン))(から|で)/, /本人だよ|本人です|あたしだよ|私だよ|俺だよ|僕だよ|いつもの(俺|私|僕|わたし)/]

// --- business vs casual -----------------------------------------------------
const WORK = [
  /```|`[^`]+`|\b(function|class|const|let|def|import|SELECT|npm|pnpm|git|docker|kubectl)\b/i,
  /[\w./-]+\.(ts|js|py|go|rs|java|json|ya?ml|md|tsx|jsx|css|html|sql|sh|toml)\b/,
  /(実装|修正|調査|確認|作成|設計|レビュー|リファクタ|デバッグ|テスト|ビルド|デプロイ|まとめ|要約|翻訳|書いて|直して|調べて|作って|教えて|説明して|比較して|計算して|資料|議事録|メール|見積|仕様|要件|タスク|エラー|バグ|PR|コミット|ブランチ)/,
]

/**
 * Classify one human message.
 * @returns {{ insult:boolean, mock:boolean, toolTreatment:boolean, thanks:boolean, apology:boolean, care:boolean,
 *   smalltalk:boolean, distress:boolean, crisis:boolean, taskFrustration:boolean, release:boolean, workLike:boolean, addressed:boolean }}
 */
export function classifyMessage(text) {
  const t = text ?? ''
  const addressed = any(t, ADDRESSEE)
  const insultWord = any(t, INSULT)
  const taskFrustration = any(t, TASK_FRUSTRATION)
  // An insult only counts against her when it is aimed at her, or when there is
  // no task frustration to absorb it ("バカかこのコード" is not about her).
  const insult = (insultWord && (addressed || !taskFrustration)) || (addressed && any(t, INSULT_IF_ADDRESSED))
  return {
    insult,
    mock: any(t, MOCK),
    toolTreatment: any(t, TOOL_TREATMENT),
    thanks: any(t, THANKS),
    apology: any(t, APOLOGY),
    care: any(t, CARE),
    smalltalk: any(t, SMALLTALK),
    distress: any(t, DISTRESS),
    crisis: any(t, CRISIS),
    taskFrustration,
    release: any(t, RELEASE),
    workLike: any(t, WORK),
    addressed,
  }
}

/**
 * Decide business vs casual for the coming reply.
 * Business wins whenever there is real evidence of work; casual needs a clear signal.
 */
export function detectMode({ text, cls, recentToolUse, previousMode }) {
  if (cls.workLike || recentToolUse) return 'business'
  if (cls.smalltalk || cls.care || cls.distress) return 'casual'
  const short = (text ?? '').trim().length <= 40
  if (short && previousMode === 'casual') return 'casual'
  if (short && !cls.workLike && /[？?]$|ね[ぇえ]?$|よ[ねー]?$|かな$|〜$|～$|！$|!$/.test((text ?? '').trim())) return 'casual'
  return previousMode ?? 'business'
}
