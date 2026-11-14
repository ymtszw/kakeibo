import { SheetsClient } from './sheets.js';
import { CONFIG } from './config.js';

const client = new SheetsClient(CONFIG.SPREADSHEET_ID);

export function setupSheets() {
  console.log('--- Initializing / Upgrading Spreadsheet Layout ---');

  // 1. Setup ナレッジベース (Only write header if empty, never overwrite user rules)
  const existingKb = client.read(`${CONFIG.SHEETS.KNOWLEDGE}!A1:F10`);
  if (!existingKb || existingKb.length === 0) {
    const kbHeader = [
      ['パターン種別', 'マッチ文字列', 'カテゴリ', '具体用途', '登録日時', '備考／メモ']
    ];
    client.writeRange(`${CONFIG.SHEETS.KNOWLEDGE}!A1:F1`, kbHeader);
    console.log('✓ ナレッジベース header initialized');
  } else {
    console.log(`✓ ナレッジベース preserved (${existingKb.length - 1} user rules found)`);
  }

  // 2. Setup ダッシュボード
  const dashRows = [
    ['📊 家計簿サマリーダッシュボード', '', ''],
    ['', '', ''],
    ['指標名', '集計値', '単位 / 備考'],
    ['当月支出合計 (2026年11月)', '=SUMIFS(\'2026年\'!D2:D, \'2026年\'!A2:A, ">=2026/11/01", \'2026年\'!A2:A, "<=2026/11/30 23:59")', '円'],
    ['年間支出累計', '=SUM(\'2026年\'!D2:D)', '円'],
    ['要ヒアリング件数 (確信度不足)', '=COUNTIF(\'2026年\'!H2:H, "要ヒアリング") + COUNTIF(\'2026年\'!H2:H, "リトライ待ち")', '件'],
    ['', '', ''],
    ['カテゴリ別内訳', '金額 (円)', '構成比'],
    ['食費', '=SUMIF(\'2026年\'!E2:E, "食費", \'2026年\'!D2:D)', '=B9/B5'],
    ['外食', '=SUMIF(\'2026年\'!E2:E, "外食", \'2026年\'!D2:D)', '=B10/B5'],
    ['食費・日用品', '=SUMIF(\'2026年\'!E2:E, "食費・日用品", \'2026年\'!D2:D)', '=B11/B5'],
    ['日用品', '=SUMIF(\'2026年\'!E2:E, "日用品", \'2026年\'!D2:D)', '=B12/B5'],
    ['趣味・娯楽', '=SUMIF(\'2026年\'!E2:E, "趣味・娯楽", \'2026年\'!D2:D)', '=B13/B5'],
    ['未分類', '=SUMIF(\'2026年\'!E2:E, "未分類", \'2026年\'!D2:D)', '=B14/B5']
  ];
  client.writeRange(`${CONFIG.SHEETS.DASHBOARD}!A1:C14`, dashRows);
  console.log('✓ ダッシュボード initialized');

  // 3. Upgrade 2026年 Ledger
  const existing = client.read(`${CONFIG.SHEETS.LEDGER_2026}!A1:F10`);
  const ledgerHeader = [
    '取引日時', '決済手段', '請求元／店舗名', '利用金額', 'カテゴリ', '具体用途', '確信スコア', 'ステータス', 'リトライ回数', '根拠メールリンク', '関連メールID群'
  ];

  const upgradedRows = [ledgerHeader];
  if (existing.length > 1) {
    for (let i = 1; i < existing.length; i++) {
      const row = existing[i];
      if (!row || row.length < 4) continue;
      const [txDate, card, vendor, amount, cat, msgId] = row;
      const isUnclassified = cat === '未分類' || vendor.includes('カードショッピング利用');
      const conf = isUnclassified ? 0.3 : 1.0;
      const status = isUnclassified ? '要ヒアリング' : '確定';
      const purpose = isUnclassified ? '用途不明（ヒアリング要）' : vendor;
      const permalink = `=HYPERLINK("https://mail.google.com/mail/u/0/#inbox/${msgId}", "Gmailを開く")`;

      upgradedRows.push([
        txDate,
        card,
        vendor,
        amount,
        cat,
        purpose,
        conf,
        status,
        0,
        permalink,
        msgId
      ]);
    }
  }

  client.writeRange(`${CONFIG.SHEETS.LEDGER_2026}!A1:K${upgradedRows.length}`, upgradedRows);
  console.log(`✓ 2026年 台帳 initialized (${upgradedRows.length - 1} records upgraded)`);
}

setupSheets();
