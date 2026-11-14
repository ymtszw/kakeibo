/**
 * Pipeline entry point (v2.1: Zero-Prior-Knowledge Full Time-Window Discovery).
 *
 *   npm run init      Create a brand-new spreadsheet from scratch (0 past data)
 *   npm run collect   Full time-window Gmail scan -> structured + universal
 *                     candidate parsers -> cross-source dedup -> KB / rules
 *                     -> evidence gathering -> ledger rows (推定待ち)
 *                     -> data/staging/pending.json
 *   (skill)           read pending.json, write data/staging/classified.json
 *   npm run apply     classified.json -> ledger (確定 / リトライ待ち / 要ヒアリング / ignore)
 *   npm run hearing   要ヒアリング rows -> data/staging/hearing.md
 *   npm run learn     data/staging/answers.json (user's answers) -> KB + ledger
 *   npm run dashboard rebuild the dashboard sheet & chart
 */
import fs from 'fs';
import { CONFIG } from './config.js';
import { fetchWindowMessages } from './gmail.js';
import { parseEmail } from './parsers.js';
import { correlateAndDeduplicate } from './dedup.js';
import { KnowledgeBase } from './knowledge.js';
import { needsExploration, gatherEvidence } from './explorer.js';
import { SheetsClient } from './sheets.js';
import { Ledger, HEADER as LEDGER_HEADER, primaryId } from './ledger.js';
import { STATUS, PENDING_CATEGORY, isConvenienceStore, isValidCategory } from './categories.js';
import { FILES, readJson, writeJson, writeText, archive } from './staging.js';
import { buildDashboard } from './dashboard.js';

// Exclude high-volume developer mailing lists / CI bots at the Gmail query level
const NOISE_QUERY_EXCLUSIONS = '-from:github.com -from:elm-lang.discourse.group -from:googlegroups.com';

const KB_HEADER = ['パターン種別', 'マッチ文字列', 'カテゴリ', '具体用途', '登録日時', '備考／メモ'];

function argValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

function loadKb(sheets) {
  return KnowledgeBase.fromSheetRows(sheets.read(`${CONFIG.SHEETS.KNOWLEDGE}!A1:F1000`));
}

/** Deterministic decisions that need no LLM. Returns the decided record or null. */
function decideDeterministically(record, kb, evidence = []) {
  const heard = kb.apply(record, evidence);
  if (heard) return heard;
  if (isConvenienceStore(record.vendor)) {
    return {
      ...record, category: 'コンビニ', purpose: 'コンビニ利用',
      confidence: 0.9, status: STATUS.CONFIRMED, note: 'rule: コンビニ'
    };
  }
  return null;
}

function writePending(ledger, evidenceCache) {
  const pending = ledger.records
    .filter(r => r.status === STATUS.PENDING)
    .map(r => ({
      key: primaryId(r),
      datetime: r.datetime, provider: r.provider, vendor: r.vendor, amount: r.amount,
      retryCount: r.retryCount, priorNote: r.note, priorPurpose: r.purpose,
      evidence: evidenceCache[primaryId(r)] || []
    }));
  writeJson(FILES.pending, pending);
  return pending;
}

export function init() {
  const title = argValue('title', '家計簿（自動集計v2）');
  const existingId = argValue('id', '');
  const created = existingId ? { spreadsheetId: existingId } : SheetsClient.createSpreadsheet(title);
  const spreadsheetId = created.spreadsheetId || created.id;
  if (!spreadsheetId) throw new Error(`Failed to create spreadsheet: ${JSON.stringify(created)}`);
  console.log(`Created new spreadsheet: ${spreadsheetId}`);

  const sheets = new SheetsClient(spreadsheetId);
  const initialSheets = sheets.listSheets();
  const firstSheet = initialSheets[0];
  if (firstSheet.title !== CONFIG.SHEETS.DASHBOARD) {
    sheets.renameSheet(firstSheet.id, CONFIG.SHEETS.DASHBOARD);
  }
  if (!initialSheets.some(s => s.title === CONFIG.SHEETS.KNOWLEDGE)) {
    sheets.addSheet(CONFIG.SHEETS.KNOWLEDGE, 1);
  }
  if (!initialSheets.some(s => s.title === '2026年')) {
    sheets.addSheet('2026年', 2);
  }

  sheets.writeRange(`${CONFIG.SHEETS.KNOWLEDGE}!A1:F1`, [KB_HEADER]);
  sheets.writeRange(`2026年!A1:M1`, [LEDGER_HEADER]);

  const cfgPath = new URL('./config.js', import.meta.url);
  const cfgText = fs.readFileSync(cfgPath, 'utf-8')
    .replace(/SPREADSHEET_ID:\s*"[^"]*"/, `SPREADSHEET_ID: "${spreadsheetId}"`);
  fs.writeFileSync(cfgPath, cfgText, 'utf-8');
  CONFIG.SPREADSHEET_ID = spreadsheetId;

  buildDashboard(sheets, { withChart: true });
  console.log(`Initialized clean spreadsheet: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
}

export function collect() {
  const sheets = new SheetsClient();
  const kb = loadKb(sheets);
  const ledger = new Ledger(sheets).load();
  const evidenceCache = readJson(FILES.evidence, {});
  const ignoredList = readJson(FILES.ignored, []);
  const ignoredSet = new Set(ignoredList);

  const days = Number(argValue('days', 14));
  const max = Number(argValue('max', 200));
  const customQuery = argValue('query', '');
  const windowQuery = customQuery
    ? `${customQuery} ${NOISE_QUERY_EXCLUSIONS}`.trim()
    : `newer_than:${days}d ${NOISE_QUERY_EXCLUSIONS}`;

  console.log(`KB ${kb.rules.length} rules / ledger ${ledger.records.length} rows / query: "${windowQuery}"`);

  // 1. Quota-safe full time-window scan (skips already-ledgered and already-ignored IDs)
  const skipIds = new Set([...ledger.messageIdSet(), ...ignoredSet]);
  const { totalListed, messages } = fetchWindowMessages(windowQuery, { max, skipIds });

  const parsed = [];
  for (const mail of messages) {
    const rec = parseEmail(mail);
    if (rec) {
      parsed.push(rec);
    } else {
      // Deterministically non-expense mail -> remember its ID so we never re-fetch it
      ignoredSet.add(mail.id);
    }
  }

  // 2. Cross-source deduplication (also reconciles against existing ledger rows)
  const existingIds = ledger.messageIdSet();
  const fresh = correlateAndDeduplicate(parsed, existingIds, ledger.records);
  console.log(`window listed ${totalListed} / inspected ${messages.length} / candidates ${parsed.length} / new transactions ${fresh.length}`);

  // 3. Decide deterministically or stage new records for in-session skill
  const added = fresh.map(rec => {
    const base = { ...rec, category: PENDING_CATEGORY, purpose: '', confidence: 0, retryCount: 0, note: '' };
    const key = rec.messageIds[0];
    const cachedNearby = (evidenceCache[key] || []).filter(e => e.role === 'nearby');
    evidenceCache[key] = [...rec.evidence];

    const directDecided = decideDeterministically(base, kb, evidenceCache[key]);
    if (directDecided) return directDecided;

    if (cachedNearby.length > 0) {
      evidenceCache[key].push(...cachedNearby);
    } else if (needsExploration(rec)) {
      evidenceCache[key].push(...gatherEvidence(rec));
    }
    const evidenceDecided = decideDeterministically(base, kb, evidenceCache[key]);
    if (evidenceDecided) return evidenceDecided;

    return { ...base, status: STATUS.PENDING };
  });
  ledger.add(added.map(({ evidence, sourceType, ...r }) => r));

  // 4. Existing rows: apply user knowledge retroactively, re-explore retries
  for (const r of ledger.records) {
    if (r.status === STATUS.HEARD) continue;
    const key = primaryId(r);
    const heard = kb.apply(r, evidenceCache[key] || []);
    if (heard) { Object.assign(r, heard); continue; }
    if (r.status === STATUS.RETRY) {
      const freshEv = needsExploration(r) ? gatherEvidence(r) : [];
      const known = new Set((evidenceCache[key] || []).map(e => e.id));
      evidenceCache[key] = [...(evidenceCache[key] || []), ...freshEv.filter(e => !known.has(e.id))];
      r.status = STATUS.PENDING;
    }
  }

  ledger.save();
  writeJson(FILES.evidence, evidenceCache);
  writeJson(FILES.ignored, [...ignoredSet]);
  const pending = writePending(ledger, evidenceCache);
  console.log(`pending for skill: ${pending.length} -> ${FILES.pending}`);
}

export function apply() {
  const classified = readJson(FILES.classified, null);
  if (!classified) { console.log('no classified.json'); return; }
  const sheets = new SheetsClient();
  const ledger = new Ledger(sheets).load();
  const ignoredSet = new Set(readJson(FILES.ignored, []));
  let ok = 0;
  let ignoredCount = 0;

  for (const c of classified) {
    if (c.ignore) {
      const idx = ledger.records.findIndex(r => primaryId(r) === c.key);
      if (idx >= 0) {
        for (const id of ledger.records[idx].messageIds) ignoredSet.add(id);
        ledger.records.splice(idx, 1);
      } else {
        ignoredSet.add(c.key);
      }
      ignoredCount++;
      continue;
    }
    const r = ledger.findByKey(c.key);
    if (!r) { console.warn(`unknown key ${c.key}`); continue; }
    if (!isValidCategory(c.category)) { console.warn(`invalid category "${c.category}" for ${c.key}`); continue; }
    const conf = Number(c.confidence) || 0;
    if (c.provider) r.provider = c.provider;
    if (c.vendor) r.vendor = c.vendor;
    if (c.amount !== undefined && Number(c.amount) > 0) r.amount = Number(c.amount);
    r.category = c.category;
    r.purpose = c.purpose || r.vendor;
    r.confidence = conf;
    r.note = c.note || '';
    if (Array.isArray(c.evidenceIds) && c.evidenceIds.length) {
      const rest = r.messageIds.slice(1).filter(id => !c.evidenceIds.includes(id));
      r.messageIds = [r.messageIds[0], ...c.evidenceIds.filter(id => id !== r.messageIds[0]), ...rest];
    }
    if (conf >= CONFIG.CONFIDENCE_THRESHOLD) {
      r.status = STATUS.CONFIRMED;
    } else {
      r.retryCount += 1;
      const ageHours = (Date.now() - Date.parse(r.datetime)) / 3600000;
      r.status = (r.retryCount > CONFIG.MAX_RETRIES || ageHours >= 48) ? STATUS.HEARING : STATUS.RETRY;
    }
    ok++;
  }
  ledger.save();
  writeJson(FILES.ignored, [...ignoredSet]);
  archive(FILES.classified);
  console.log(`applied ${ok} / ignored ${ignoredCount} (total ${classified.length})`);
  hearing(ledger);
}

export function hearing(preloaded) {
  const ledger = preloaded || new Ledger(new SheetsClient()).load();
  const rows = ledger.records.filter(r => r.status === STATUS.HEARING);
  const lines = [
    `# 要ヒアリング一覧（${rows.length}件）`, '',
    '| key | 取引日時 | 決済手段 | 店舗名 | 金額 | 暫定カテゴリ | 暫定用途 | メモ | メール |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${primaryId(r)} | ${r.datetime} | ${r.provider} | ${r.vendor} | ${r.amount} | ${r.category} | ${r.purpose} | ${r.note} | [開く](https://mail.google.com/mail/u/0/#inbox/${primaryId(r)}) |`)
  ];
  writeText(FILES.hearing, lines.join('\n') + '\n');
  console.log(`hearing: ${rows.length} -> ${FILES.hearing}`);
}

export function learn() {
  const answers = readJson(FILES.answers, null);
  if (!answers) { console.log('no answers.json'); return; }
  const sheets = new SheetsClient();
  const evidenceCache = readJson(FILES.evidence, {});
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

  const kbRows = [];
  const directTxns = [];

  for (const a of answers) {
    if (!isValidCategory(a.category)) throw new Error(`invalid category "${a.category}"`);
    const pattern = a.patternType || (a.matchStr ? 'CONTAINS' : 'TXN');
    if (pattern === 'TXN' || !a.matchStr) {
      directTxns.push(a);
    } else {
      kbRows.push([pattern, a.matchStr, a.category, a.purpose || '', today, a.note || 'ヒアリング回答']);
    }
  }

  if (kbRows.length > 0) {
    sheets.appendRows(CONFIG.SHEETS.KNOWLEDGE, kbRows);
  }
  archive(FILES.answers);
  console.log(`KB += ${kbRows.length} / direct TXN = ${directTxns.length}`);

  const kb = loadKb(sheets);
  const ledger = new Ledger(sheets).load();
  let n = 0;

  for (const a of directTxns) {
    const r = ledger.findByKey(a.key);
    if (r) {
      r.category = a.category;
      r.purpose = a.purpose || r.purpose || r.vendor;
      r.confidence = 1.0;
      r.status = STATUS.HEARD;
      r.note = a.note || 'ヒアリング回答(単発)';
      n++;
    }
  }

  for (const r of ledger.records) {
    const heard = kb.apply(r, evidenceCache[primaryId(r)] || []);
    if (heard && (r.status !== STATUS.HEARD || r.purpose !== heard.purpose || r.category !== heard.category || r.note !== heard.note)) {
      Object.assign(r, heard);
      n++;
    }
  }

  ledger.save();
  console.log(`ledger rows updated: ${n}`);
  hearing(ledger);
}

const commands = {
  init, collect, apply, hearing: () => hearing(), learn,
  dashboard: () => buildDashboard(new SheetsClient(), { withChart: !process.argv.includes('--no-chart') })
};
const cmd = process.argv[2];
if (commands[cmd]) commands[cmd]();
else if (cmd) console.error(`unknown command: ${cmd} (${Object.keys(commands).join(', ')})`);
