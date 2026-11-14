/**
 * Category master. Classification of anything outside these goes to "その他".
 * "未分類" is NOT a category: it is the placeholder while a record awaits
 * estimation or user hearing.
 */
export const CATEGORIES = ['食費', 'コンビニ', '趣味・娯楽', '通信費', 'その他'];
export const PENDING_CATEGORY = '未分類';

export const STATUS = {
  PENDING: '推定待ち',     // awaiting the in-session classification skill
  CONFIRMED: '確定',       // confidence >= threshold
  RETRY: 'リトライ待ち',    // low confidence, will be re-explored on a later run
  HEARING: '要ヒアリング',  // retries exhausted, ask the user
  HEARD: 'ヒアリング済'     // answered by the user (via knowledge base)
};

/**
 * Deterministic category-only rule: convenience stores are hard to break down
 * by content, so they always go to "コンビニ" (user policy 2026-11-14).
 */
const CONVENIENCE_RE = /セブン[－\-ー]?イレブン|7-?ELEVEN|ローソン|LAWSON|ファミリーマート|ファミマ|FAMILYMART|ミニストップ|MINISTOP|デイリーヤマザキ|ＮＥＷＤＡＹＳ|NEWDAYS|セイコーマート|ポプラ/i;

export function isConvenienceStore(vendor) {
  return CONVENIENCE_RE.test(vendor || '');
}

/** Map legacy (v1) category labels onto the current master. */
export function mapLegacyCategory(cat, vendor = '') {
  if (isConvenienceStore(vendor)) return 'コンビニ';
  switch (cat) {
    case '食費':
    case '外食':
      return '食費';
    case 'コンビニ':
    case '趣味・娯楽':
    case '通信費':
    case 'その他':
      return cat;
    case '食費・日用品':
    case '日用品':
    case '未分類':
    case '':
    case undefined:
      return PENDING_CATEGORY; // needs re-estimation
    default:
      return 'その他';
  }
}

export function isValidCategory(cat) {
  return CATEGORIES.includes(cat);
}
