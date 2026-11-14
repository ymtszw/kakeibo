---
name: kakeibo-classify
description: >-
  Classify pending household-ledger transactions (`data/staging/pending.json`),
  explore surrounding Gmail messages when evidence is thin, write
  `data/staging/classified.json`, and run interactive user hearing / exclusion
  reviews (`data/staging/answers.json`, `除外ドメイン`). Use whenever syncing,
  reviewing, classifying, or hearing on kakeibo transactions.
---

# kakeibo-classify (In-Session Exploration & Classification Skill)

Connects the deterministic pipeline (`src/index.js`) with in-session AI classification and user review.
**Never hardcode natural-language keyword/category heuristics into `src/*.js`.** Scripts handle extraction and deduplication; this skill handles semantic classification, evidence inspection, and confidence scoring.

---

## 1. Category Master (Strict — 5 Categories Only)

Use **only** these 5 exact category strings (`日用品`, `外食`, `食費・日用品` are deprecated):

| Category | Scope |
|---|---|
| `食費` | Restaurants, dining out, cafes, fast food, supermarkets, groceries, snacks, meal delivery (`nosh`, `Uber Eats`, `モスバーガー`, `マクドナルド`, etc.) |
| `コンビニ` | Convenience stores (`セブン-イレブン`, `ローソン`, `ファミリーマート`, `ミニストップ`, `NewDays`, etc.) |
| `趣味・娯楽` | Games & in-app purchases (`Steam`, `COGNOSPHERE`, `HoYoverse`), books/comics/manga (`Kindle`, `FANZAブックス`), digital/doujin goods (`DMM`/`FANZA`, `BOOTH`), movies, events |
| `通信費` | Mobile plans/top-ups (`povo`), ISPs, cloud/server/network infrastructure (`Cloudflare`, `さくらインターネット`, `GitHub`, `iCloud+`, VPN) |
| `その他` | All other expenses not fitting the 4 above (apparel/`ユニクロ`, electronics/gadgets, household goods, medical, transit, etc.) |

> `未分類` is a status placeholder for `推定待ち` / `リトライ待ち` / `要ヒアリング` rows. **Never output `未分類` in `classified.json`.**

---

## 2. Standard Pipeline Execution

### Step 1: Deterministic Collection (`collect`)
```powershell
npm run collect
# Options: node src/index.js collect --days 14 --max 200
```
- Scans all emails in the time window (skipping only `確定除外` domains via `-from:<domain>` and cached/known IDs in `mail_cache.json` / `ignored_ids.json`).
- Merges card notices with receipts when both exist; stages standalone receipts or card notices in `data/staging/pending.json`.

### Step 2: In-Session Exploration & Classification
1. Read `data/staging/pending.json` (do **not** use Python; use `read_file` or Node.js).
2. Inspect `vendor` and `evidence` (source + nearby mail excerpts) for each item:
   - **Universal candidates (`provider` ending in `(メール検出)`)**:
     - Refine `provider` (e.g. `Uber Eats`, `Apple (Visa-XXXX)`, `nosh`), `vendor`, `amount` (tax-included total), `category`, and `purpose`.
     - If a candidate is a non-payment notice (e.g. terms update, shipping notice) or a duplicate of another card row, set `"ignore": true`.
   - **Self-evident merchants** (e.g. `モスバーガー` -> `食費`): set `confidence: 0.85..0.98`.
   - **Generic descriptors (`Amazon.co.jp`, `PayPal`, `APPLE.COM/BILL`, `カードショッピング利用`)**:
     - Identify the exact item from `evidence` (or run `gmail readonly search` / `gmail readonly get` around the timestamp/amount if needed).
   - **Ambiguous items** (multiple plausible categories/purposes or missing receipt for a generic charge):
     - Do **not** guess. Set `confidence: 0.4..0.6` and explain what needs confirmation in `note`.
3. Write `data/staging/classified.json`:
```json
[
  {
    "key": "<messageId-A>",
    "category": "食費",
    "purpose": "モスバーガー",
    "confidence": 0.95,
    "evidenceIds": [],
    "note": "skill: restaurant"
  }
]
```

### Step 3: Apply Classifications (`apply`)
```powershell
npm run apply
```
- `confidence >= 0.8` -> `確定`
- `confidence < 0.8` -> increments retry count (`<= 2` -> `リトライ待ち`, `> 2` or no further mail evidence -> `要ヒアリング`) and updates `data/staging/hearing.md`.

### Step 4: Interactive User Hearing & Knowledge Learning (`ask_question` -> `learn`)
- If `data/staging/hearing.md` has items (or low-confidence items exist with no further Gmail evidence), call `ask_question`:
  - Group identical merchants when appropriate.
  - State datetime, payment method, merchant, and amount in `question`.
  - Offer concrete `Category / Purpose` choices in `options`, prefixing the best candidate with `(Recommended)`.
- **Never write unconfirmed guesses to `ナレッジベース`.**
- After the user answers, write `data/staging/answers.json` and run `npm run learn` + `npm run dashboard`:
  - Reusable merchant/keyword rules: `"scope": "CONTAINS"` / `"EXACT"` / `"REGEX"` with `"pattern"`, `"category"`, `"purpose"` (appended to `ナレッジベース`).
  - One-off transaction answers: `"scope": "TXN"` with `"key"`, `"category"`, `"purpose"` (updates the ledger row directly to `ヒアリング済` without bloating `ナレッジベース`).

### Step 5: Mandatory Excluded-Domain Review (`除外ドメイン` Sheet / `ask_question`)
- After `collect`, **always read `除外ドメイン!A1:F100` via `gsheets readonly read`** (even when `pending.json` has 0 items).
- If any row has status `除外提案`, **always call `ask_question`** to ask whether each domain should be `確定除外` or `除外取消`, and update the `除外ドメイン` sheet immediately.
- Only `確定除外` domains are added as `-from:<domain>` in future Gmail queries. Always confirm before excluding domains that may carry receipts or personal/billing messages (e.g. `github.com`, `gmail.com`).
