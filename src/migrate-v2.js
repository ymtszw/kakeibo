/**
 * One-off migration v1 -> v2 (2026-11-14).
 *  - ISO 8601 (JST) timestamps
 *  - new category master (食費 / コンビニ / 趣味・娯楽 / 通信費 / その他)
 *  - re-parse every source mail with the fixed parsers (exact 利用日, amounts)
 *  - drop all v1 auto-classifications that were not confirmed by the user;
 *    they go back to 推定待ち with fresh evidence for the classification skill
 *  - 13-column layout (根拠メール / 参考メール / 推定メモ)
 */
import { CONFIG } from './config.js';
import { SheetsClient } from './sheets.js';
import { getMessage } from './gmail.js';
import { parseEmail } from './parsers.js';
import { KnowledgeBase } from './knowledge.js';
import { needsExploration, gatherEvidence } from './explorer.js';
import { Ledger } from './ledger.js';
import { toIsoJst } from './normalize.js';
import { STATUS, PENDING_CATEGORY, isConvenienceStore, mapLegacyCategory } from './categories.js';
import { FILES, writeJson } from './staging.js';
import { buildDashboard } from './dashboard.js';

const sheets = new SheetsClient();
const LEDGER = CONFIG.SHEETS.LEDGER_2026;

// 1. KB: only remap category labels to the new master (content = user's answers, untouched)
const kbRows = sheets.read(`${CONFIG.SHEETS.KNOWLEDGE}!A1:F1000`);
const kbFixed = kbRows.map((r, i) => {
  if (i === 0) return r;
  const c = mapLegacyCategory(r[2], r[1]);
  return [r[0], r[1], c === PENDING_CATEGORY ? 'その他' : c, r[3] || '', r[4] || '', r[5] || ''];
});
sheets.writeRange(`${CONFIG.SHEETS.KNOWLEDGE}!A1:F${kbFixed.length}`, kbFixed);
const kb = KnowledgeBase.fromSheetRows(kbFixed);
console.log('KB categories remapped:', kbFixed.slice(1).map(r => `${r[1]}=>${r[2]}`).join(', '));

// 2. Ledger rows (v1 layout: ids in column K)
const oldRows = sheets.read(`${LEDGER}!A1:K1000`).slice(1).filter(r => r && r[0]);
const evidence = {};
const records = [];
let dropped = 0;

for (const old of oldRows) {
  const ids = String(old[10] || '').split(',').map(s => s.trim()).filter(Boolean);
  const key = ids[0];
  let rec = {
    datetime: toIsoJst(old[0]), provider: old[1], vendor: old[2],
    amount: parseInt(old[3], 10) || 0, messageIds: [key]
  };
  const mail = key ? getMessage(key) : null;
  const parsed = mail ? parseEmail(mail) : null;
  if (parsed) {
    rec = { datetime: parsed.datetime, provider: parsed.provider, vendor: parsed.vendor, amount: parsed.amount, messageIds: [key] };
    evidence[key] = parsed.evidence;
  } else if (mail && /dmm\.com/.test(mail.from)) {
    console.log(`drop (no cash-out): ${key} ${old[2]} ${old[3]}`);
    dropped++;
    continue;
  }

  const base = { ...rec, category: PENDING_CATEGORY, purpose: '', confidence: 0, retryCount: 0, note: '' };
  const heard = kb.apply(base);
  if (heard) { records.push(heard); continue; }
  if (isConvenienceStore(rec.vendor)) {
    records.push({ ...base, category: 'コンビニ', purpose: 'コンビニ利用', confidence: 0.9, status: STATUS.CONFIRMED, note: 'rule: コンビニ' });
    continue;
  }
  evidence[key] = [
    ...(evidence[key] || []),
    { id: key, role: 'v1-ledger', excerpt: `v1分類(未確認): ${old[4]} / ${old[5]}` }
  ];
  if (needsExploration(rec)) evidence[key].push(...gatherEvidence(rec));
  records.push({ ...base, status: STATUS.PENDING });
  process.stdout.write('.');
}
console.log(`\nmigrated ${records.length} rows (dropped ${dropped})`);

// 3. write back in v2 layout
sheets.clear(`${LEDGER}!A1:M1000`);
const ledger = new Ledger(sheets);
ledger.knownSheets = new Set([LEDGER]);
ledger.records = records;
ledger.save();
writeJson(FILES.evidence, evidence);
writeJson(FILES.pending, records.filter(r => r.status === STATUS.PENDING).map(r => ({
  key: r.messageIds[0], datetime: r.datetime, provider: r.provider, vendor: r.vendor,
  amount: r.amount, retryCount: 0, evidence: evidence[r.messageIds[0]] || []
})));
buildDashboard(sheets, { year: 2026, withChart: true });
console.log('done');
