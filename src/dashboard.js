/**
 * Dashboard sheet: KPIs, category breakdown, 12-month trend table, and embedded
 * column chart for the current year.
 * Ledger timestamps are ISO 8601 text ("YYYY-MM-DDTHH:mm:ss+09:00"), so months
 * are matched with LEFT(A, 7).
 */
import { CONFIG } from './config.js';
import { CATEGORIES, PENDING_CATEGORY } from './categories.js';

export function buildDashboard(sheets, { year = new Date().getFullYear(), withChart = true } = {}) {
  const L = `'${year}年'`;
  const A = `${L}!$A$2:$A`, D = `${L}!$D$2:$D`, E = `${L}!$E$2:$E`, H = `${L}!$H$2:$H`;
  const monthSumCell = cell => `=SUMPRODUCT((LEFT(${A},7)=${cell})*${D})`;
  const monthSumLiteral = ym => `=SUMPRODUCT((LEFT(${A},7)="${ym}")*${D})`;
  const catSum = (monthCell, catCell) =>
    monthCell
      ? `=SUMPRODUCT((LEFT(${A},7)=${monthCell})*(${E}=${catCell})*${D})`
      : `=SUMPRODUCT((${E}=${catCell})*${D})`;

  const rows = [
    [`📊 家計簿ダッシュボード（${year}年）`, '', '', ''],
    ['', '', '', ''],
    ['指標', '値', '', ''],
    ['当月', '=TEXT(TODAY(),"yyyy-mm")', '', ''],
    ['前月', '=TEXT(EDATE(TODAY(),-1),"yyyy-mm")', '', ''],
    ['当月支出（円）', monthSumCell('$B$4'), '', ''],
    ['前月支出（円）', monthSumCell('$B$5'), '', ''],
    ['前月比', '=IFERROR(TEXT(B6/B7-1,"+0.0%;-0.0%"),"-")', '', ''],
    ['当年累計（円）', `=SUM(${D})`, '', ''],
    ['要ヒアリング件数', `=COUNTIF(${H},"要ヒアリング")`, '', ''],
    ['推定待ち・リトライ待ち件数', `=COUNTIF(${H},"推定待ち")+COUNTIF(${H},"リトライ待ち")`, '', ''],
    ['', '', '', ''],
    ['カテゴリ別支出', '当月（円）', '前月（円）', '当年累計（円）']
  ];

  const catFirstRow = rows.length + 1;
  for (const cat of [...CATEGORIES, PENDING_CATEGORY]) {
    const r = rows.length + 1;
    rows.push([cat, catSum('$B$4', `$A${r}`), catSum('$B$5', `$A${r}`), catSum(null, `$A${r}`)]);
  }
  const catLastRow = rows.length;
  rows.push([
    '合計',
    `=SUM(B${catFirstRow}:B${catLastRow})`,
    `=SUM(C${catFirstRow}:C${catLastRow})`,
    `=SUM(D${catFirstRow}:D${catLastRow})`
  ]);

  rows.push(['', '', '', '']);
  const trendStartIdx = rows.length; // 0-based index of ['月', '支出（円）']
  rows.push(['月', '支出（円）', '', '']);
  for (let m = 1; m <= 12; m++) {
    const ym = `${year}-${String(m).padStart(2, '0')}`;
    rows.push([`=TEXT(DATE(${year},${m},1),"yyyy-mm")`, monthSumLiteral(ym), '', '']);
  }
  const trendEndIdx = rows.length; // exclusive 0-based index (header + 12 months)
  rows.push(['当年合計', `=SUM(B${trendStartIdx + 2}:B${trendEndIdx})`, '', '']);

  sheets.clear(`${CONFIG.SHEETS.DASHBOARD}!A1:F60`);
  sheets.writeRange(`${CONFIG.SHEETS.DASHBOARD}!A1:D${rows.length}`, rows);

  if (withChart) {
    const dash = sheets.listSheets().find(s => s.title === CONFIG.SHEETS.DASHBOARD);
    if (dash) {
      const existingCharts = sheets.listCharts().filter(c => c.sheet_id === dash.id);
      const requests = existingCharts.map(c => ({
        deleteEmbeddedObject: { objectId: c.chart_id }
      }));
      requests.push({
        addChart: {
          chart: {
            spec: {
              title: `${year}年 月別支出推移（円）`,
              basicChart: {
                chartType: 'COLUMN',
                legendPosition: 'BOTTOM_LEGEND',
                axis: [
                  { position: 'BOTTOM_AXIS', title: '月' },
                  { position: 'LEFT_AXIS', title: '支出（円）' }
                ],
                domains: [
                  {
                    domain: {
                      sourceRange: {
                        sources: [
                          {
                            sheetId: dash.id,
                            startRowIndex: trendStartIdx,
                            endRowIndex: trendEndIdx,
                            startColumnIndex: 0,
                            endColumnIndex: 1
                          }
                        ]
                      }
                    }
                  }
                ],
                series: [
                  {
                    series: {
                      sourceRange: {
                        sources: [
                          {
                            sheetId: dash.id,
                            startRowIndex: trendStartIdx,
                            endRowIndex: trendEndIdx,
                            startColumnIndex: 1,
                            endColumnIndex: 2
                          }
                        ]
                      }
                    },
                    targetAxis: 'LEFT_AXIS'
                  }
                ],
                headerCount: 1
              }
            },
            position: {
              overlayPosition: {
                anchorCell: { sheetId: dash.id, rowIndex: 1, columnIndex: 5 },
                widthPixels: 640,
                heightPixels: 380
              }
            }
          }
        }
      });
      sheets.rawBatch(requests);
    }
  }
  return rows.length;
}
