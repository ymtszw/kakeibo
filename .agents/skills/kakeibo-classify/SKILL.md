---
name: kakeibo-classify
description: >-
  Classify pending household-ledger transactions produced by the deterministic
  collector (`data/staging/pending.json`), explore surrounding Gmail messages
  when evidence is thin, write `data/staging/classified.json`, and run user
  hearing / knowledge-base updates (`data/staging/answers.json`). Use whenever
  syncing, reviewing, classifying, or hearing on kakeibo transactions.
---

# kakeibo-classify (セッション内探索・用途推定スキル)

決定論的スクリプト (`src/index.js`) と、セッション内でのAI探索・推定をつなぐパイプラインスキルです。
**スクリプトに自然言語の分類ロジック（キーワード決め打ち・カテゴリ固定値）をハードコードしてはなりません。**
事実抽出と重複排除はスクリプトが行い、意味理解・周辺メール読解・確信度判断はこのスキルが行います。

---

## 1. カテゴリマスタ（厳守）

以下の **5カテゴリのみ** を使用します（`日用品`・`外食`・`食費・日用品` は廃止済）：

| カテゴリ | 対象 |
|---|---|
| `食費` | 飲食店・外食・カフェ・ファストフード・スーパー・食品・軽食（オフィスグリコ、モスバーガー、マクドナルド、すぱじろう、リンガーハット、壱角家、ミスタードーナツ等すべて統合） |
| `コンビニ` | コンビニエンスストア利用全般（セブン-イレブン、ローソン、ファミリーマート、ミニストップ、NewDays等。品目内訳の区別が困難なため一律 `コンビニ`） |
| `趣味・娯楽` | ゲーム・課金（Steam、COGNOSPHERE、HoYoverse等）、書籍・コミック・マンガ（Kindle/Amazonコミックス等）、同人・デジタルコンテンツ（DMM/FANZA等）、映画・イベント |
| `通信費` | 携帯回線・トッピング（povo等）、ISP、クラウド/通信インフラ |
| `その他` | 上記4カテゴリに当てはまらないすべての出費（衣類・ユニクロ、家電・ガジェット、雑貨、医療、交通、用途特定のうえ他カテゴリに属さないもの） |

> `未分類` はカテゴリではなく、`推定待ち` / `リトライ待ち` / `要ヒアリング` 中のプレースホルダです。`classified.json` に `未分類` を出力してはいけません。

---

## 2. 標準パイプライン実行手順

### Step 1: 決定論的収集 (`collect` — 期間内全メール走査)
```powershell
npm run collect
# オプション: node src/index.js collect --days 14 --max 200
```
- **事前知識不要の全件走査**: 特定のカード会社やECサイトに限定せず、対象期間内（デフォルト直近14日間 `newer_than:14d`）の全メールを走査（`data/staging/mail_cache.json` と `ignored_ids.json` によりAPIレート制限を回避しつつ差分のみ取得）。
- **2段階フィルタ＋重複突合**:
  - 既知パーサー（Vpass、au PAYカード、au PAY、DMM）に加え、ユニバーサル候補検出器（`parseUniversalCandidate`）が金額＋決済/注文/領収キーワードを持つ全メールを自動検出（配送通知・月次請求額確定通知・認証コード等は決定論的に除外）。
  - カード通知と領収書メールが両方届いている場合は金額・時刻で自動マージし、領収書のみの決済（サブスク、カード通知対象外決済、新規サービス等）は単独レコードとしてステージング。

### Step 2: セッション内での探索・推定（本スキル）
1. `data/staging/pending.json` を読む。
2. 各レコードについて、`vendor`（店舗名）と `evidence`（本文抜粋・周辺メール）を読む：
   - **ユニバーサル検出候補（`provider` が `〇〇 (メール検出)` のもの）**:
     - 本文抜粋から正確な `provider`（例：`Uber Eats`、`Apple (Visa-XXXX)`、`nosh (定期配送)`）、`vendor`、`amount`（税込支払総額）、`category`、`purpose` を確定して `classified.json` に指定する。
     - 万一、決済ではないメールや既に別カード通知と統合済みの重複メールが含まれていた場合は `"ignore": true` を指定すると台帳から削除され `ignored_ids.json` に記録される。
   - **店舗名から業態が自明な場合**（例：`モスバーガー` → `食費`、`ユニクロ` → `その他`）：`confidence: 0.85〜0.95`。
   - **Amazon / PayPal / Steam / カードショッピング利用 等の汎用決済名**：
     - `evidence` 内の周辺メール（注文確認、povoトッピング購入完了、Steam領収書等）から**具体的な品目**を特定する。
     - 예: Amazonの注文メールが `〇〇 (ジャンプコミックスDIGITAL)` なら `カテゴリ: 趣味・娯楽`、`具体用途: Amazon: 〇〇 (コミック)`、`confidence: 0.92`。
     - `evidence` だけで不足する場合は、`gmail readonly search` / `gmail readonly get` で周辺時刻・同額のメールを追加探索してよい。
   - **タイトルや用途が複数候補あり断定できない場合**（例：`HoYoverse` 課金だが原神・スタレ・ゼンゼロのどれかメールから判別不能、または周辺メール無しの `PayPal決済`）：
     - 勝手に決めつけず、`confidence: 0.4〜0.6` とし、`note` に迷っている点（ヒアリングしたい論点）を明記する。
3. 結果を `data/staging/classified.json` に書き出す：
```json
[
  {
    "key": "<messageId-A>",
    "category": "食費",
    "purpose": "モスバーガー",
    "confidence": 0.95,
    "evidenceIds": [],
    "note": "店舗名から飲食店利用と判定"
  }
]
```
- `evidenceIds`: 用途特定の根拠となった周辺メールID（あれば指定すると台帳の「参考メール」列にパーマリンクが入る）。

### Step 3: 推定結果の適用 (`apply`)
```powershell
npm run apply
```
- `confidence >= 0.8` → `確定`
- `confidence < 0.8` → `リトライ回数` を+1し、2回以下なら `リトライ待ち`、2回超なら `要ヒアリング` に遷移。
- `data/staging/hearing.md` が自動更新される。

### Step 4: セッション内プロンプトによるユーザーヒアリング & ナレッジ学習 (`ask_question` ➔ `learn`)
- `data/staging/hearing.md` に出力された `要ヒアリング` 項目（および周辺領収メールが存在せずリトライしても情報が増えない `リトライ待ち` 項目）について、**セッション内の `ask_question` ツール（選択肢＋自由入力UI）を呼び出して対話的にヒアリング**する。
- **質問設計ルール（`ask_question`）**:
  - 同一請求元パターン（例：`COGNOSPHERE`、`HoYoverse`、`pixivFANBOX`）はまとめて質問してよい。
  - `question` には対象取引の「日時・決済手段・請求元・金額」を明記する。
  - `options` には推定される「カテゴリ / 具体用途」と「今後も同ルールを適用するか（`CONTAINS` ルール化） / 今回のみか（`TXN` 単発）」を組み合わせた選択肢を提示し、最有力候補の先頭に `(Recommended)` を付ける（UI側で自動的に番号と「Other（自由記述）」が付与される）。
- **ナレッジベースにはユーザーが回答した確定情報のみを登録する（推測で書き込むことは厳禁）。**
- ユーザーがプロンプトに回答したら、直ちに `data/staging/answers.json` を生成し、`npm run learn` と `npm run dashboard` を実行してナレッジベースおよび台帳・ダッシュボードへ反映する：
```json
[
  {
    "patternType": "CONTAINS",
    "matchStr": "HoYoverse",
    "category": "趣味・娯楽",
    "purpose": "ゼンゼロ課金",
    "note": "ユーザーヒアリング回答"
  },
  {
    "patternType": "TXN",
    "key": "<messageId-B>",
    "category": "趣味・娯楽",
    "purpose": "〇〇購入 (PayPal)",
    "note": "単発取引のヒアリング回答"
  }
]
```
- 店舗名や周辺メール内のキーワードとして今後も再利用できる回答は `EXACT` / `CONTAINS` / `REGEX` を指定する（`ナレッジベース` シートに追記され、`CONTAINS` / `REGEX` は `vendor` だけでなく周辺メール抜粋にも照合される）。
- その1回限りの単発回答は `TXN`（`key` 指定）を使う。`TXN` は **`ナレッジベース` シートには書き込まれず、取引台帳の該当行のみを直接 `ヒアリング済 (confidence: 1.0)` に更新**するため、ナレッジベースシートが単発IDで肥大化しない。
