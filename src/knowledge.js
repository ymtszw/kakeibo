/**
 * Knowledge base = ONLY reusable merchant/evidence rules confirmed by the user
 * through hearing (EXACT / CONTAINS / REGEX).
 * One-off transaction answers (TXN) are written directly to the ledger sheet
 * so they never clutter the Knowledge Base sheet.
 */
import { STATUS, isValidCategory } from './categories.js';

export class KnowledgeBase {
  constructor(rules = []) {
    this.rules = rules;
  }

  match(record, evidence = []) {
    const vendor = (record.vendor || '').toLowerCase();
    const nearbyText = (evidence || [])
      .map(e => `${e.from || ''} ${e.subject || ''} ${e.excerpt || ''}`)
      .join(' ')
      .toLowerCase();

    for (const rule of this.rules) {
      const needle = (rule.matchStr || '').toLowerCase();
      if (!needle) continue;
      let hit = false;
      if (rule.patternType === 'EXACT') {
        hit = vendor === needle;
      } else if (rule.patternType === 'REGEX') {
        try {
          const re = new RegExp(rule.matchStr, 'i');
          hit = re.test(record.vendor || '') || re.test(nearbyText);
        } catch {
          hit = false;
        }
      } else {
        // CONTAINS: match vendor OR nearby receipt evidence
        hit = vendor.includes(needle) || nearbyText.includes(needle);
      }
      if (hit) return rule;
    }
    return null;
  }

  /** Returns a new record with the user's answer applied, or null if no rule matches. */
  apply(record, evidence = []) {
    const rule = this.match(record, evidence);
    if (!rule) return null;
    return {
      ...record,
      category: isValidCategory(rule.category) ? rule.category : 'その他',
      purpose: rule.purpose || record.purpose,
      confidence: 1.0,
      status: STATUS.HEARD,
      note: `KB: ${rule.patternType} "${rule.matchStr}"`
    };
  }

  static fromSheetRows(rows) {
    const rules = (rows || []).slice(1)
      .filter(r => r && r[1] && (r[0] || '').trim() !== 'TXN')
      .map(r => ({
        patternType: (r[0] || 'CONTAINS').trim(),
        matchStr: (r[1] || '').trim(),
        category: (r[2] || '').trim(),
        purpose: (r[3] || '').trim(),
        registeredAt: (r[4] || '').trim(),
        notes: (r[5] || '').trim()
      }));
    return new KnowledgeBase(rules);
  }
}
