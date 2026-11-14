/**
 * Deterministic parsers & universal payment-candidate detector:
 *  1. Structured parsers (Vpass, au PAY Card, au PAY, DMM) extract exact fields.
 *  2. Universal candidate parser (`parseUniversalCandidate`) detects ANY order,
 *     receipt, invoice, subscription, or payment notice from unknown/unlisted
 *     services without prior sender knowledge.
 *  3. Non-expense operational mails (shipping updates, monthly card bill totals,
 *     auth codes, newsletters) are deterministically excluded.
 */
import { toIsoJst } from './normalize.js';

export function plainText(body) {
  return (body || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function cleanAmount(str) {
  if (!str) return 0;
  const intPart = String(str).trim().replace(/\.\d+$/, '');
  return parseInt(intPart.replace(/[^0-9]/g, ''), 10) || 0;
}

function excerpt(text, max = 600) {
  return text.replace(/\s+/g, ' ').slice(0, max);
}

function base(email, fields) {
  return {
    sourceType: fields.sourceType,
    provider: fields.provider,
    datetime: toIsoJst(fields.datetime) || toIsoJst(email.date),
    vendor: (fields.vendor || '不明').normalize('NFKC').replace(/\s+/g, ' ').trim(),
    amount: fields.amount,
    messageIds: [email.id],
    evidence: [{
      id: email.id,
      role: 'source',
      from: email.from,
      subject: email.subject,
      excerpt: fields.excerpt
    }]
  };
}

/** 三井住友カード / Olive (Vpass) "ご利用のお知らせ" */
export function parseVpass(email) {
  const { subject, from } = email;
  if (!from.includes('vpass.ne.jp') || !subject.includes('ご利用のお知らせ')) return null;
  const text = plainText(email.body);

  const amountMatch = text.match(/利用金額[：:]\s*([0-9,]+(?:\.\d+)?)\s*(?:円|JPY)/i);
  const amount = cleanAmount(amountMatch && amountMatch[1]);
  if (amount <= 0) return null;

  const card = ((text.match(/ご利用カード[：:]\s*([^\n]+)/) || [])[1] || '').normalize('NFKC').trim();
  let provider = '三井住友カード';
  if (/Olive/i.test(card)) provider = 'Olive (三井住友)';
  else if (/ゴールド|Gold/i.test(card)) provider = '三井住友カードゴールドVISA';

  const dt = (text.match(/◇?利用日(?:時)?[：:]\s*([0-9\/]+\s+[0-9:]+)/) || [])[1];
  const vendor = (text.match(/◇?利用先[：:]\s*([^\n]+)/) || [])[1];
  const kind = (text.match(/◇?利用取引[：:]\s*([^\n]+)/) || [])[1] || '';

  return base(email, {
    sourceType: 'CARD_NOTICE', provider, datetime: dt, vendor, amount,
    excerpt: `利用先: ${vendor || '?'} / 取引: ${kind} / ${amount}円 / カード: ${card}`
  });
}

/** au PAY カード 【ご利用速報】 / au PAY (code payment) */
export function parseAuPay(email) {
  const { subject, from } = email;
  const isCard = from.includes('kddi-fs.com') && subject.includes('ご利用速報');
  const isCode = from.includes('auone.jp') && subject.includes('au PAY') && subject.includes('ご利用のお知らせ');
  if (!isCard && !isCode) return null;
  const text = plainText(email.body);

  if (isCard) {
    const dt = (text.match(/▼ご利用日時\s*\n\s*([^\n]+)/) || [])[1];
    const vendor = (text.match(/▼ご利用内容\s*\n\s*([^\n]+)/) || [])[1] || '不明';
    const amount = cleanAmount((text.match(/▼ご利用金額\s*\n\s*([0-9,]+)\s*円/) || [])[1]);
    if (amount <= 0) return null;
    return base(email, {
      sourceType: 'CARD_NOTICE',
      provider: 'au PAY カード（Mastercard）',
      datetime: dt, vendor, amount,
      excerpt: `ご利用内容: ${vendor} / ${amount}円`
    });
  }

  const kind = ((text.match(/■種別\s*\n\s*([^\n]+)/) || [])[1] || '').trim();
  if (kind && kind !== '支払い') return null;
  const vendor = (text.match(/■利用店舗\s*\n\s*([^\n]+)/) || [])[1] || '不明';
  const dt = (text.match(/■利用日時\s*\n\s*([^\n]+)/) || [])[1];
  const amount = cleanAmount((text.match(/■支払い金額\s*\n\s*([0-9,]+)\s*円/) || [])[1]);
  if (amount <= 0) return null;

  return base(email, {
    sourceType: 'PAY_NOTICE',
    provider: 'au PAY',
    datetime: dt, vendor, amount,
    excerpt: `利用店舗: ${vendor} / 種別: ${kind} / ${amount}円`
  });
}

/** DMM / FANZA "購入完了のお知らせ" */
export function parseDmm(email) {
  const { subject, from } = email;
  if (!from.includes('dmm.com') || !subject.includes('購入完了')) return null;
  const text = plainText(email.body);

  const amount = cleanAmount((text.match(/購入額\s*[：:]\s*([0-9,]+)\s*円/) || [])[1]);
  if (amount <= 0) return null;

  const service = (text.match(/([^\s]+)をご利用いただき/) || [])[1] || 'DMM';
  const payment = ((text.match(/支払方法\s*[：:]\s*([^\n]+)/) || [])[1] || '').trim();
  const items = [...text.matchAll(/^\s*\d+\s+(.+?)\s+[0-9,]+円\s*$/gm)].map(m => m[1]).slice(0, 5);

  return base(email, {
    sourceType: 'ORDER_RECEIPT',
    provider: `DMM (${payment || '支払方法不明'})`,
    datetime: email.date, vendor: service, amount,
    excerpt: `サービス: ${service} / 購入額: ${amount}円 / 支払: ${payment} / 商品: ${items.join(' | ') || '?'}`
  });
}

const NON_EXPENSE_SUBJECT_RE = /発送済み|配達中|配達済み|配達未完了|お荷物お届けのお知らせ|本日、お荷物をお届け|伝票番号が確定|商品の発送準備|発送手続きが完了|商品発送に関するお知らせ|お支払い金額のお知らせ|お引き落とし日のお知らせ|ご利用分のご請求のお支払いが完了|認証コード|認証メール|追加認証|ログインがありました|セキュリティ通知|セキュリティ強化|利用規約の更新|会員規約改定|新着作品が販売開始|作品更新のお知らせ|フォローしたレーベル|相当が当たる|ポイント貯まっています|メールマガジン|アプリ強制アップデート|お手続き完了のお知らせ|アカウント情報変更|SNSログイン連携|新規会員登録|一次登録完了|アカウントを作成しました|メニューの変更が完了|各種変更受付中|Web Analytics weekly|Algolia Usage|Google 検索結果における|フォームにご記入いただき|メンテナンス|不正アクセスによる|再開について|寄附受付再開|Welcome to|connection to Twitch|no longer connected|公式チャージでポイントを貯めて/i;

const TRANSACTION_SUBJECT_RE = /ご注文|注文済み|購入|決済|お支払い|支払い受領|領収書|ご利用|ご請求|引き落とし|チャージ|トッピング|invoice|receipt|order\s*#|Purchase confirmed/i;

function senderLabel(fromHeader) {
  if (!fromHeader) return '不明';
  const quoted = fromHeader.match(/^"?([^"<]+)"?\s*</);
  if (quoted && quoted[1].trim() && !quoted[1].includes('@')) {
    return quoted[1].trim().replace(/\s*の領収書$/, '');
  }
  const dom = fromHeader.match(/@([a-z0-9.-]+)/i);
  return dom ? dom[1] : fromHeader.slice(0, 30);
}

/**
 * Universal candidate detector for any order/receipt/payment/invoice email
 * without prior knowledge of the sender or payment method.
 */
export function parseUniversalCandidate(email) {
  const subject = (email.subject || '').normalize('NFKC');
  const from = email.from || '';
  if (NON_EXPENSE_SUBJECT_RE.test(subject)) return null;
  if (!TRANSACTION_SUBJECT_RE.test(subject)) return null;

  const text = plainText(email.body);

  // Skip 0-yen point/coupon purchases (e.g. Amazon Kindle "*総計: ￥ 0")
  if (/\*?総計\s*[：:]\s*[¥￥\\]\s*0(?:\b|\D)/.test(text)) return null;

  let amount = 0;
  let currencyNote = '';

  // 1. PayPal JPY conversion or explicit JPY payment
  const paypalJpy = text.match(/換算前\s*[：:]\s*[¥￥\\]?\s*([0-9,]+)\s*JPY/i)
    || text.match(/[¥￥\\]\s*([0-9,]+)\s*JPYのお支払いが実行されました/i);
  // 2. Amazon Kindle "*総計: ￥ NNN"
  const kindleTotal = text.match(/\*?総計\s*[：:]\s*[¥￥\\]?\s*([0-9,]+)/);
  // 3. Multi-order "合計 NNNN JPY" blocks (e.g. Amazon physical multi-order email)
  const jpyTotals = [...text.matchAll(/合計\s+([0-9,]+)\s*JPY/gi)]
    .map(m => cleanAmount(m[1]))
    .filter(n => n > 0);
  // 4. Labeled tax-included total (合計 / 支払額 / 総計 / 購入額 / ご利用金額 / 領収額)
  const primaryTotal = text.match(/(?:<合計>|支払額|合計(?!\s*[（(]税抜)|総計|購入額|ご利用金額|領収額)\s*(?:[（(][^）)]*[）)])?\s*[：:]?\s*(?:Cash\s*)?[¥￥\\]?\s*([0-9,]+)\s*(?:円|JPY|\/月|（税込）)?/i);
  const labeledTotal = primaryTotal || text.match(/(?:お支払い|請求額)\s*(?:[（(][^）)]*[）)])?\s*[：:]?\s*(?:Cash\s*)?[¥￥\\]?\s*([0-9,]+)\s*(?:円|JPY|\/月|（税込）)?/i);
  // 5. Generic JPY amount in body
  const genericJpy = text.match(/[¥￥\\]\s*([0-9,]+)|([0-9,]+)\s*(?:円|JPY)/i);
  // 6. USD amount (e.g. Cloudflare $5.50)
  const usdMatch = text.match(/\$([0-9]+(?:\.[0-9]{2})?)/);

  if (paypalJpy) {
    amount = cleanAmount(paypalJpy[1]);
  } else if (kindleTotal) {
    amount = cleanAmount(kindleTotal[1]);
  } else if (jpyTotals.length > 0) {
    amount = jpyTotals.reduce((a, b) => a + b, 0);
  } else if (labeledTotal && cleanAmount(labeledTotal[1]) > 0) {
    amount = cleanAmount(labeledTotal[1]);
  } else if (genericJpy) {
    amount = cleanAmount(genericJpy[1] || genericJpy[2]);
  } else if (usdMatch) {
    const usd = parseFloat(usdMatch[1]);
    if (usd > 0) {
      amount = Math.round(usd * 155);
      currencyNote = `[外貨 $${usdMatch[1]} USD ≒ ${amount}円] `;
    }
  }

  if (amount <= 0) return null;

  const sender = senderLabel(from);
  return base(email, {
    sourceType: 'ORDER_RECEIPT',
    provider: `${sender} (メール検出)`,
    datetime: email.date,
    vendor: `${sender}: ${subject.slice(0, 50)}`,
    amount,
    excerpt: `${currencyNote}差出人: ${from} / 件名: ${subject} / 抜粋: ${excerpt(text, 550)}`
  });
}

export function parseEmail(email) {
  return parseVpass(email) || parseAuPay(email) || parseDmm(email) || parseUniversalCandidate(email) || null;
}

export { excerpt };
