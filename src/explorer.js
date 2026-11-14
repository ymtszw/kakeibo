/**
 * Evidence gathering around a transaction. This module NEVER classifies:
 * it only collects nearby mails (same amount within ±1 day, or anything
 * within ±windowMin minutes) and hands them to the classification skill.
 */
import { searchMessages, getMessage } from './gmail.js';
import { toEpochSec } from './normalize.js';
import { plainText } from './parsers.js';

// Payment notifications themselves are not useful as "what was bought" evidence.
const NOISE_SENDERS = /vpass\.ne\.jp|kddi-fs\.com|github\.com|notifications@/i;

export function needsExploration(record) {
  const v = record.vendor || '';
  if (record.provider && record.provider.startsWith('au PAY カード')) return true; // notices never name the merchant
  return /カードショッピング利用|Visa加盟店|不明|PAYPAL|ＰａｙＰａｌ|AMAZON|ＡＭＡＺＯＮ|GOOGLE|APPLE|STEAM|WL \*|Battle\.Net|FANBOX|HoYoverse|BOOTH|ブース/i.test(v);
}

export function gatherEvidence(record, { windowMin = 30, maxItems = 4 } = {}) {
  const t = toEpochSec(record.datetime);
  if (!t || !record.amount) return [];

  const amt = String(record.amount);
  const amtComma = record.amount.toLocaleString('en-US');
  const amtTerms = amt === amtComma ? amt : `(${amt} OR ${amtComma})`;
  const queries = [
    `${amtTerms} after:${t - 86400} before:${t + 86400}`,
    `after:${t - windowMin * 60} before:${t + windowMin * 60}`
  ];

  const own = new Set(record.messageIds || []);
  const seen = new Set();
  const out = [];

  for (const q of queries) {
    for (const cand of searchMessages(q, 6)) {
      if (own.has(cand.id) || seen.has(cand.id)) continue;
      seen.add(cand.id);
      const msg = getMessage(cand.id);
      if (!msg || NOISE_SENDERS.test(msg.from)) continue;

      const text = plainText(msg.body).replace(/\s+/g, ' ');
      const pos = Math.max(text.indexOf(amtComma), text.indexOf(amt));
      const snippet = pos >= 0
        ? text.slice(Math.max(0, pos - 250), pos + 150)
        : (msg.snippet || text).slice(0, 300);

      out.push({
        id: msg.id,
        role: 'nearby',
        from: msg.from,
        subject: msg.subject,
        minutesApart: Math.round((Number(msg.internalDate) / 1000 - t) / 60),
        amountInBody: pos >= 0,
        excerpt: snippet
      });
    }
  }

  out.sort((a, b) =>
    (b.amountInBody - a.amountInBody) || (Math.abs(a.minutesApart) - Math.abs(b.minutesApart)));
  return out.slice(0, maxItems);
}
