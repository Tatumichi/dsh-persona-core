# dsh-persona-core

DeepSeek Harness（dsh）のすべての会話に、**ひとりの、あなた専用に育つ人格**を持たせるプラグインです。

- 構造化された人格定義（`persona.yaml`）
- 仕事モード／雑談モードの自動切り替え
- 機嫌と傷つき（不快なことが続くと冷たくなり、優しくされると少しずつ戻る）
- 長期記憶（あなたのこと・二人の出来事・彼女自身について決まったこと・話の続き）
- 「いつもの相手か」をなんとなく感じ取る認識（機能は一切ブロックしない）
- 本人だけが知る過去（初回に非公開で生成され、信頼に応じて少しずつ話せるようになる）
- 出力側の口調補正（一人称・絵文字）と、口調のずれの検出

検証済み: `@deepseek-ai/dsh` **0.2.1-rc.2**（2026-10-23）。dsh は developer preview のため、他のバージョンでは動かない可能性があります。

## インストール

```bash
dsh plugin --profile web add ./dsh-persona-core-0.1.0.tgz
dsh --profile web --dump-config | grep -A8 dsh-persona-core   # 読み込まれたか確認
dsh web
```

アンインストールは `dsh plugin --profile web remove dsh-persona-core`。保存データ（下記）は残るので、不要なら手で消してください。

## データの置き場所

すべて `$DSH_HOME/persona-core/`（既定 `~/.dsh/persona-core/`）に、本人だけが読める権限（0600）で保存されます。外部には送信しません。

| ファイル | 中身 | 編集してよいか |
|---|---|---|
| `persona.yaml` | 人格の骨格。初回に既定値が書き出される | ◎ 保存すると再起動なしで反映 |
| `memories.jsonl` | 記憶（1行1件） | ○ 行を消せば忘れる |
| `state.json` | 機嫌・関係性・認識プロフィール（統計値のみ） | △ 消すと関係がリセット |
| `hidden/backstory.json` | 非公開の過去 | ✕ 見るとネタバレ。消すと次回起動時に作り直し |

## 設定

`cordis.patch.yml`（プロファイルの patch でも上書き可）:

| 項目 | 既定 | 説明 |
|---|---|---|
| `characterName` | `''` | 名前。`persona.yaml` の `name` でも可 |
| `userName` | `''` | 呼び名を固定。空なら会話から覚える |
| `timeZone` | システム | 時間感覚・日替わりの気分に使用 |
| `toneCorrection` | `casual` | 出力の口調補正。`casual`=雑談のみ / `always` / `off` |
| `subagent` | `short` | サブエージェントの人格。`short`=口調だけ / `full` / `off` |
| `provider` / `model` | 会話と同じ | 記憶の整理・過去の生成に使うモデル |
| `distillEvery` | `4` | 何ターンごとに記憶を整理するか |
| `recallLimit` | `8` | 1回に思い出す記憶の数 |
| `emotion` / `memory` / `recognition` / `backstory` / `drift` | `true` | 各機能のオン／オフ |

## 仕組み

| dsh の拡張点 | 使い方 |
|---|---|
| system-prompt section（order 1） | 人格の骨格。会話中は変わらないので、プロンプトキャッシュが効く |
| runtime context（order 300、会話ごと） | モード・気分・冷たさ・記憶・時間・過去など、毎回変わるもの |
| `agent/created` | 会話ごとに状態を結び付ける。サブエージェントには短い口調だけ |
| `agent/pre-step` | あなたの発言を読み、今回の返答の前に状態を更新 |
| `session/event` | ツール使用・返答・ターン終了を観測し、記憶をまとめる |
| `llm/stream` | 彼女の発言テキストだけを補正（文字の断片と完成文の両方を一致させて書き換え） |
| tools | `memory_recall` / `memory_save` |

口調補正が触らないもの: コードブロック、インラインコード、URL、`>` 引用行、「」『』の中、思考過程、ツール呼び出し。メール文面などの下書きは「」や引用に入れれば元の文体のまま残ります。

## 注意

- **これはセキュリティ機能ではありません。** ユーザー認識は雰囲気を変えるだけで、作業の手伝いは誰に対しても普段どおり行います。
- 共用 PC では、他の人の文体の統計も記録されます。
- dsh の仕組み上、モデルへのリクエストはログに残ります。過去の「解放されていない層」はプロンプトに入れないので、ログを見てもネタバレしにくくしています。
- 「消えたい」など深刻な発言を検知すると、キャラクターより真剣な対応を優先するよう指示します。
- `PERSONA_CORE_DEBUG_FILE=/path/to/file` を設定すると、動作ログ（内容は含まない）をファイルに書き出します。

## 未実装（今後）

- Web 設定画面（人格・記憶の閲覧と編集、補正前後の表示）
- LLM による最終応答の書き換え（層 D）と、口調への指摘からの学習
- 端末ごとの認識プロフィール
- 感情イベントの LLM 分類（現在は規則ベース）

## テスト

```bash
npm test
```

## ライセンス

MIT

## 設計資料

- [docs/requirements.md](docs/requirements.md) — 開発の可否・要件定義・実装状況
- [docs/backstory-generator.md](docs/backstory-generator.md) — 非公開の過去の生成仕様
