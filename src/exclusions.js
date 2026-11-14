/**
 * Sender-domain exclusion manager ("除外ドメイン" sheet, placed right of "ナレッジベース").
 *
 * Lifecycle:
 *   - 除外提案: Auto-proposed when a domain sends >= 3 non-expense mails (or known list/bot).
 *              Still scanned (NOT excluded from Gmail query) until human confirms!
 *   - 確定除外: Human-confirmed exclusion -> added as `-from:<domain>` in Gmail search.
 *   - 除外取消: Human-rejected exclusion -> never excluded and never re-proposed.
 */
import { CONFIG } from './config.js';

export const EXCLUSION_STATUS = {
  PROPOSED: '除外提案',
  CONFIRMED: '確定除外',
  CANCELLED: '除外取消'
};

export const EXCLUSION_HEADER = [
  '送信元ドメイン', 'ステータス', '代表件名／サンプル', '非決済通数', '更新日', '備考／レビュー指示'
];

export function extractDomain(fromHeader) {
  const m = String(fromHeader || '').match(/@([a-z0-9.-]+)/i);
  return m ? m[1].toLowerCase() : '';
}

export class ExclusionStore {
  constructor(sheets) {
    this.sheets = sheets;
    this.entries = new Map(); // domain -> entry
    this.dirty = false;
  }

  ensureSheet() {
    const list = this.sheets.listSheets();
    if (!list.some(s => s.title === CONFIG.SHEETS.EXCLUSIONS)) {
      this.sheets.addSheet(CONFIG.SHEETS.EXCLUSIONS, 2);
      this.sheets.writeRange(`${CONFIG.SHEETS.EXCLUSIONS}!A1:F1`, [EXCLUSION_HEADER]);
      this.applyDropdown();
    }
  }

  applyDropdown() {
    this.sheets.setDropdown(
      `${CONFIG.SHEETS.EXCLUSIONS}!B2:B1000`,
      [EXCLUSION_STATUS.PROPOSED, EXCLUSION_STATUS.CONFIRMED, EXCLUSION_STATUS.CANCELLED]
    );
  }

  load() {
    this.ensureSheet();
    const rows = this.sheets.read(`${CONFIG.SHEETS.EXCLUSIONS}!A1:F1000`);
    this.entries.clear();
    for (const r of (rows || []).slice(1)) {
      const domain = (r[0] || '').trim().toLowerCase();
      if (!domain) continue;
      this.entries.set(domain, {
        domain,
        status: (r[1] || EXCLUSION_STATUS.PROPOSED).trim(),
        sample: (r[2] || '').trim(),
        count: parseInt(r[3], 10) || 0,
        updatedAt: (r[4] || '').trim(),
        note: (r[5] || '').trim()
      });
    }
    return this;
  }

  /** Only human-confirmed domains are excluded at Gmail query level. */
  confirmedDomains() {
    return [...this.entries.values()]
      .filter(e => e.status === EXCLUSION_STATUS.CONFIRMED)
      .map(e => e.domain);
  }

  /**
   * Propose noisy non-expense domains for human review (minCount >= 3).
   * Never overrides 確定除外 or 除外取消, and skips domains that had any
   * expense candidate in the same batch.
   */
  recordObservedNoise(nonExpenseMails, candidateMails, { minCount = 3, protectedDomains = new Set() } = {}) {
    const candidateDomains = new Set([
      ...protectedDomains,
      ...candidateMails.map(m => extractDomain(m.from)).filter(Boolean)
    ]);
    const stats = new Map();

    for (const m of nonExpenseMails) {
      const dom = extractDomain(m.from);
      if (!dom || candidateDomains.has(dom)) continue;
      if (!stats.has(dom)) stats.set(dom, { count: 0, sample: m.subject || '' });
      stats.get(dom).count += 1;
    }

    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    for (const [dom, info] of stats) {
      const existing = this.entries.get(dom);
      if (existing) {
        if (existing.status === EXCLUSION_STATUS.CANCELLED || existing.status === EXCLUSION_STATUS.CONFIRMED) {
          continue;
        }
        existing.count += info.count;
        if (!existing.sample && info.sample) existing.sample = info.sample.slice(0, 60);
        existing.updatedAt = today;
        this.dirty = true;
      } else if (info.count >= minCount) {
        this.entries.set(dom, {
          domain: dom,
          status: EXCLUSION_STATUS.PROPOSED,
          sample: (info.sample || '').slice(0, 60),
          count: info.count,
          updatedAt: today,
          note: '高頻度・非決済メールとして自動提案（レビュー待ち）'
        });
        this.dirty = true;
      }
    }
  }

  seedProposed(domainsWithSamples) {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    for (const { domain, sample, note } of domainsWithSamples) {
      const dom = domain.toLowerCase();
      if (this.entries.has(dom)) continue;
      this.entries.set(dom, {
        domain: dom,
        status: EXCLUSION_STATUS.PROPOSED,
        sample: sample || '',
        count: 0,
        updatedAt: today,
        note: note || '初期提案（レビュー待ち）'
      });
      this.dirty = true;
    }
  }

  save() {
    if (!this.dirty) return;
    const order = { [EXCLUSION_STATUS.PROPOSED]: 0, [EXCLUSION_STATUS.CONFIRMED]: 1, [EXCLUSION_STATUS.CANCELLED]: 2 };
    const sorted = [...this.entries.values()].sort(
      (a, b) => ((order[a.status] ?? 9) - (order[b.status] ?? 9)) || (b.count - a.count)
    );
    const rows = [
      EXCLUSION_HEADER,
      ...sorted.map(e => [e.domain, e.status, e.sample, e.count, e.updatedAt, e.note])
    ];
    this.sheets.clear(`${CONFIG.SHEETS.EXCLUSIONS}!A1:F1000`);
    this.sheets.writeRange(`${CONFIG.SHEETS.EXCLUSIONS}!A1:F${rows.length}`, rows);
    this.applyDropdown();
    this.dirty = false;
  }
}
