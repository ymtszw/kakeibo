/**
 * Date/time normalization. All ledger timestamps are ISO 8601 in JST, e.g.
 * "2026-11-11T21:40:00+09:00". Strings sort lexicographically == chronologically.
 */

const pad = n => String(n).padStart(2, '0');
const ISO_JST_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/;
const HAS_TZ_RE = /([+-]\d{2}:?\d{2}|GMT|UTC|Z)\s*(\(.*\))?$/;

export function toIsoJst(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  const s = String(raw).trim().replace(/\u3000/g, ' ');
  if (ISO_JST_RE.test(s)) return s;

  let ms = NaN;
  // Local (zone-less) Japanese formats: 2026/11/8 16:31, 2026年11月13日(金) 18:15:43, etc.
  const cleaned = s.replace(/\([月火水木金土日]\)/g, ' ');
  const m = cleaned.match(/^(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})日?(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m && !HAS_TZ_RE.test(s)) {
    ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0) - 9, +(m[5] || 0), +(m[6] || 0));
  } else {
    ms = Date.parse(s); // RFC 2822 mail headers, ISO with offset, etc.
  }
  if (Number.isNaN(ms)) return '';

  const d = new Date(ms + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+09:00`;
}

export function toEpochSec(isoOrRaw) {
  const iso = toIsoJst(isoOrRaw);
  return iso ? Math.floor(Date.parse(iso) / 1000) : null;
}

export function yearOf(iso) {
  return iso ? iso.slice(0, 4) : '';
}
