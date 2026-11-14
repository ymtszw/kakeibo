/**
 * Year-sheet ledger store ("2026年", "2025年", ...). The sheet is the source of
 * truth; this module converts rows <-> records and rewrites whole year sheets.
 * Sheet tab order invariant:
 *   Index 0: ダッシュボード
 *   Index 1: ナレッジベース
 *   Index 2+: Year sheets ordered newest year on the left (e.g. 2026年, 2025年, ...)
 */
import { CONFIG } from './config.js';
import { PENDING_CATEGORY, STATUS } from './categories.js';
import { toIsoJst, yearOf } from './normalize.js';

export const HEADER = [
  '取引日時', '決済手段', '請求元／店舗名', '利用金額', 'カテゴリ', '具体用途',
  '確信スコア', 'ステータス', 'リトライ回数', '根拠メール', '参考メール', '関連メールID群', '推定メモ'
];
const LAST_COL = 'M';
const YEAR_SHEET_RE = /^(\d{4})年$/;

const gmailUrl = id => `https://mail.google.com/mail/u/0/#inbox/${id}`;
const link = (id, label) => (id ? `=HYPERLINK("${gmailUrl(id)}", "${label}")` : '');

export function primaryId(record) {
  return (record.messageIds || [])[0] || '';
}

export function recordToRow(r) {
  const ids = r.messageIds || [];
  return [
    r.datetime, r.provider, r.vendor, r.amount,
    r.category || PENDING_CATEGORY, r.purpose || '',
    r.confidence ?? 0, r.status || STATUS.PENDING, r.retryCount || 0,
    link(ids[0], '根拠メール'), link(ids[1], '参考メール'),
    ids.join(','), r.note || ''
  ];
}

export function rowToRecord(row) {
  return {
    datetime: toIsoJst(row[0]),
    provider: row[1] || '',
    vendor: row[2] || '',
    amount: parseInt(String(row[3] || '0').replace(/[^0-9-]/g, ''), 10) || 0,
    category: row[4] || PENDING_CATEGORY,
    purpose: row[5] || '',
    confidence: parseFloat(row[6]) || 0,
    status: row[7] || STATUS.PENDING,
    retryCount: parseInt(row[8], 10) || 0,
    messageIds: String(row[11] || '').split(',').map(s => s.trim()).filter(Boolean),
    note: row[12] || ''
  };
}

export class Ledger {
  constructor(sheets) {
    this.sheets = sheets;
    this.records = [];
    this.knownSheets = new Set();
  }

  load() {
    const yearSheets = this.sheets.listSheets().filter(s => YEAR_SHEET_RE.test(s.title));
    this.knownSheets = new Set(yearSheets.map(s => s.title));
    this.records = [];
    for (const s of yearSheets) {
      const rows = this.sheets.read(`${s.title}!A1:${LAST_COL}5000`);
      for (const row of rows.slice(1)) {
        if (row && row[0]) this.records.push(rowToRecord(row));
      }
    }
    return this;
  }

  messageIdSet() {
    return new Set(this.records.flatMap(r => r.messageIds));
  }

  findByKey(key) {
    return this.records.find(r => primaryId(r) === key);
  }

  add(records) {
    this.records.push(...records);
  }

  /** Enforces tab order: [ダッシュボード, ナレッジベース, 除外ドメイン, <newest year>年, ...] */
  ensureSheetOrder() {
    const all = this.sheets.listSheets();
    const dash = all.find(s => s.title === CONFIG.SHEETS.DASHBOARD);
    const kb = all.find(s => s.title === CONFIG.SHEETS.KNOWLEDGE);
    const excl = all.find(s => s.title === CONFIG.SHEETS.EXCLUSIONS);
    const years = all
      .filter(s => YEAR_SHEET_RE.test(s.title))
      .sort((a, b) => Number(b.title.match(YEAR_SHEET_RE)[1]) - Number(a.title.match(YEAR_SHEET_RE)[1]));

    const desired = [dash, kb, excl, ...years].filter(Boolean);
    const requests = [];
    desired.forEach((s, idx) => {
      if (s.index !== idx) {
        requests.push({
          updateSheetProperties: {
            properties: { sheetId: s.id, index: idx },
            fields: 'index'
          }
        });
      }
    });
    if (requests.length > 0) {
      this.sheets.rawBatch(requests);
    }
  }

  /** Rewrites every year sheet, newest year tab on the left. */
  save() {
    const byYear = new Map();
    for (const r of this.records) {
      const y = yearOf(r.datetime);
      if (!y) continue;
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(r);
    }
    // Sort years newest first (e.g. 2026, 2025)
    const sortedYears = [...byYear.keys()].sort((a, b) => Number(b) - Number(a));
    for (const year of sortedYears) {
      const title = `${year}年`;
      if (!this.knownSheets.has(title)) {
        this.sheets.addSheet(title);
        this.knownSheets.add(title);
      }
      const recs = byYear.get(year);
      recs.sort((a, b) => (a.datetime < b.datetime ? 1 : a.datetime > b.datetime ? -1 : 0));
      const data = [HEADER, ...recs.map(recordToRow)];
      this.sheets.clear(`${title}!A1:${LAST_COL}5000`);
      this.sheets.writeRange(`${title}!A1:${LAST_COL}${data.length}`, data);
    }
    this.ensureSheetOrder();
  }
}
