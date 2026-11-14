/**
 * Deduplication: one real-world payment == one ledger row.
 *  1. Skip any record whose source mail is already referenced in the ledger.
 *  2. Collapse multiple ORDER_RECEIPT mails for the same purchase (same amount
 *     within ±180 min, e.g. PayPal + store order, Steam wallet + Steam purchase,
 *     Cloudflare confirm + invoice).
 *  3. Merge ORDER_RECEIPT into a matching CARD_NOTICE / PAY_NOTICE in the same
 *     batch (same amount within ±36 hours).
 *  4. Reconcile against existing ledger rows (`existingRecords`):
 *     - If a new ORDER_RECEIPT matches an existing ledger row (same amount
 *       within ±36h), attach its messageId to the existing row as a reference
 *       mail instead of creating a duplicate row.
 *     - If a new CARD_NOTICE matches an existing receipt-detected ledger row
 *       (same amount within ±36h), upgrade the existing row's payment provider
 *       and attach the card notice ID instead of creating a duplicate row.
 */
import { toEpochSec } from './normalize.js';

const RECEIPT_DEDUP_MIN = 180;
const CARD_RECEIPT_MERGE_MIN = 36 * 60; // 36 hours

export function correlateAndDeduplicate(records, existingMessageIds = new Set(), existingRecords = []) {
  const fresh = records.filter(r => !r.messageIds.some(id => existingMessageIds.has(id)));
  const notices = fresh.filter(r => r.sourceType !== 'ORDER_RECEIPT');
  const rawReceipts = fresh.filter(r => r.sourceType === 'ORDER_RECEIPT');

  // Step 1: Collapse duplicate ORDER_RECEIPT mails within the fresh batch
  const receipts = [];
  for (const r of rawReceipts) {
    const tr = toEpochSec(r.datetime);
    const match = receipts.find(existing => {
      if (existing.amount !== r.amount) return false;
      const sameVendorPrefix = existing.provider === r.provider && /DMM|Amazon/i.test(r.provider);
      const windowMin = sameVendorPrefix ? 5 : RECEIPT_DEDUP_MIN;
      const diff = Math.abs(toEpochSec(existing.datetime) - tr) / 60;
      return diff <= windowMin;
    });
    if (match) {
      for (const id of r.messageIds) {
        if (!match.messageIds.includes(id)) match.messageIds.push(id);
      }
      match.evidence.push(...r.evidence.map(e => ({ ...e, role: 'nearby' })));
    } else {
      receipts.push(r);
    }
  }

  // Step 2: Merge fresh ORDER_RECEIPT into fresh CARD_NOTICE / PAY_NOTICE
  const usedReceipts = new Set();
  for (const n of notices) {
    const tn = toEpochSec(n.datetime);
    let best = null;
    let bestDiff = Infinity;
    for (const r of receipts) {
      if (usedReceipts.has(r)) continue;
      const diff = Math.abs(tn - toEpochSec(r.datetime)) / 60;
      const sameAmount = r.amount === n.amount && diff <= CARD_RECEIPT_MERGE_MIN;
      const senderToken = (r.provider || '').replace(/\s*\(.*$/, '').trim().toLowerCase();
      const sameMerchantImmediate = senderToken.length >= 4
        && (n.vendor || '').toLowerCase().includes(senderToken)
        && diff <= 15;
      if ((sameAmount || sameMerchantImmediate) && diff < bestDiff) {
        best = r;
        bestDiff = diff;
      }
    }
    if (best) {
      usedReceipts.add(best);
      for (const id of best.messageIds) {
        if (!n.messageIds.includes(id)) n.messageIds.push(id);
      }
      n.evidence.push(...best.evidence.map(e => ({ ...e, role: 'nearby' })));
    }
  }

  // Step 3: Reconcile remaining fresh records against existing ledger rows
  const survivingNotices = [];
  for (const n of notices) {
    const tn = toEpochSec(n.datetime);
    const matchInLedger = existingRecords.find(ex => {
      if (ex.amount !== n.amount) return false;
      const diff = Math.abs(toEpochSec(ex.datetime) - tn) / 60;
      return diff <= CARD_RECEIPT_MERGE_MIN && /\(メール検出\)/.test(ex.provider || '');
    });
    if (matchInLedger) {
      matchInLedger.provider = n.provider;
      for (const id of n.messageIds) {
        if (!matchInLedger.messageIds.includes(id)) matchInLedger.messageIds.unshift(id);
      }
    } else {
      survivingNotices.push(n);
    }
  }

  const survivingReceipts = [];
  for (const r of receipts) {
    if (usedReceipts.has(r)) continue;
    const tr = toEpochSec(r.datetime);
    const matchInLedger = existingRecords.find(ex => {
      if (ex.amount !== r.amount) return false;
      // Do not merge two separate DMM purchases of the same price on the same day into each other
      if (/^DMM/.test(ex.provider || '') && /^DMM/.test(r.provider || '')) return false;
      const diff = Math.abs(toEpochSec(ex.datetime) - tr) / 60;
      return diff <= CARD_RECEIPT_MERGE_MIN;
    });
    if (matchInLedger) {
      for (const id of r.messageIds) {
        if (!matchInLedger.messageIds.includes(id)) matchInLedger.messageIds.push(id);
      }
    } else {
      survivingReceipts.push(r);
    }
  }

  return [...survivingNotices, ...survivingReceipts];
}
