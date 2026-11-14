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
   * Propose noisy non-expense domains for human review when they send >= 10
   * non-expense mails per 30-day month.
   * Never overrides 確定除外 or 除外取消, and skips protectedDomains.
   */
  recordObservedNoise(nonExpenseMails, candidateMails, { minPerMonth = 10, protectedDomains = new Set() } = {}) {
    const candidateDomains = new Set([
      ...protectedDomains,
      ...candidateMails.map(m => extractDomain(m.from)).filter(Boolean)
    ]);
    // Group by domain -> month ("YYYY-MM") to measure true monthly volume
    const stats = new Map();

    for (const m of nonExpenseMails) {
      const dom = extractDomain(m.from);
      if (!dom || candidateDomains.has(dom)) continue;
      const ms = Number(m.internalDate) || Date.parse(m.date) || Date.now();
      const ym = new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 7);
      if (!stats.has(dom)) stats.set(dom, { total: 0, byMonth: new Map(), sample: m.subject || '' });
      const s = stats.get(dom);
      s.total += 1;
      s.byMonth.set(ym, (s.byMonth.get(ym) || 0) + 1);
    }

    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    for (const [dom, info] of stats) {
      const maxMonthly = Math.max(0, ...info.byMonth.values());
      const existing = this.entries.get(dom);
      if (existing) {
        if (existing.status === EXCLUSION_STATUS.CANCELLED || existing.status === EXCLUSION_STATUS.CONFIRMED) {
          continue;
        }
        if (maxMonthly < minPerMonth) {
          this.entries.delete(dom);
          this.dirty = true;
          continue;
        }
        if (existing.count !== maxMonthly) {
          existing.count = maxMonthly;
          existing.updatedAt = today;
          this.dirty = true;
        }
      } else if (maxMonthly >= minPerMonth) {
        this.entries.set(dom, {
          domain: dom,
          status: EXCLUSION_STATUS.PROPOSED,
          sample: (info.sample || '').slice(0, 60),
          count: maxMonthly,
          updatedAt: today,
          note: `月${maxMonthly}通の非決済メールとして自動提案（レビュー待ち）`
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
