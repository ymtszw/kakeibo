---
name: kakeibo-daily-sync
description: >-
  Execute the end-to-end daily kakeibo sync pipeline in
  c:\Users\yumatsuzawa\workspace\kakeibo: collect recent emails, classify
  pending transactions via kakeibo-classify, apply results, rebuild the
  dashboard, run interactive excluded-domain and hearing reviews, and summarize
  outcomes. Use for scheduled or manual daily kakeibo syncs.
---

# kakeibo-daily-sync (Daily Pipeline Skill)

End-to-end orchestration for the daily household-ledger sync in `c:\Users\yumatsuzawa\workspace\kakeibo`.

## Prerequisites
- **Read `.agents/skills/kakeibo-classify/SKILL.md` first** for the strict 5-category master, classification rules, and staging file schemas.
- **Never use Python** on Windows. Use `read_file`, `write_file`, or Node.js (`node ...`).

---

## Pipeline Steps

### 1. Collect Recent Emails
Run the deterministic collector for the last 3 days (unless overridden by caller arguments):
```powershell
node src/index.js collect --days 3 --max 200
```

### 2. Classify Pending Transactions
1. Read `data/staging/pending.json`.
2. Classify all items into `data/staging/classified.json` following `.agents/skills/kakeibo-classify/SKILL.md`:
   - Inspect `vendor` and `evidence` (use `gmail readonly search` / `gmail readonly get` when evidence for generic descriptors is thin).
   - **Do not guess**: mark genuinely uncertain items with `confidence < 0.75` so they transition to `要ヒアリング`.
   - Set `"ignore": true` for non-payment notices or duplicates.

### 3. Apply & Rebuild Dashboard
Run:
```powershell
node src/index.js apply
node src/index.js dashboard
```

### 4. Mandatory Excluded-Domain Review & User Hearing
1. **Always** read `除外ドメイン!A1:F100` via `gsheets readonly read` (even when `data/staging/pending.json` had 0 items).
2. Read `data/staging/hearing.md` (if present/non-empty).
3. If any row in `除外ドメイン!A1:F100` has status `除外提案` **or** `data/staging/hearing.md` has items:
   - Call `ask_question` to confirm each `除外提案` domain (`確定除外` or `除外取消`) and/or resolve `要ヒアリング` items.
   - Apply confirmed hearing answers to `data/staging/answers.json` and run `node src/index.js learn` + `node src/index.js dashboard`.
   - Apply confirmed domain exclusions (`確定除外` / `除外取消`) to the `除外ドメイン` sheet via `gsheets mutate`.

### 5. Summarize Results
Provide a concise summary covering:
- Newly registered transactions
- `要ヒアリング` items (and any resolved answers)
- `除外提案` review results
