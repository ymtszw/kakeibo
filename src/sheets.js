import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CONFIG } from './config.js';

const run = cmd => execSync(cmd, { shell: 'powershell', encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 });

export class SheetsClient {
  constructor(spreadsheetId = CONFIG.SPREADSHEET_ID) {
    this.spreadsheetId = spreadsheetId;
  }

  static createSpreadsheet(title) {
    const out = run(`gsheets mutate create --title "${title}"`).trim();
    const m = out.match(/ID:\s*([A-Za-z0-9_-]+)/);
    if (m) return { spreadsheetId: m[1] };
    return JSON.parse(out);
  }

  /** gsheets batch (values are USER_ENTERED, so "=HYPERLINK(...)" becomes a formula). */
  batch(operations) {
    const tmpFile = path.join(os.tmpdir(), `gsheets_batch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.json`);
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(operations), 'utf-8'); // no BOM
      return run(`gsheets mutate batch ${this.spreadsheetId} -f "${tmpFile}"`);
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  }

  /** Raw Google Sheets API BatchUpdateSpreadsheetRequest ({ requests: [...] }). */
  rawBatch(requests) {
    if (!requests || requests.length === 0) return '';
    const tmpFile = path.join(os.tmpdir(), `gsheets_raw_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.json`);
    try {
      fs.writeFileSync(tmpFile, JSON.stringify({ requests }), 'utf-8');
      return run(`gsheets mutate raw-batch ${this.spreadsheetId} -f "${tmpFile}"`);
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  }

  read(range, valueRenderOption = '') {
    try {
      const opt = valueRenderOption ? ` --value-render-option ${valueRenderOption}` : '';
      return JSON.parse(run(`gsheets readonly read ${this.spreadsheetId} "${range}"${opt} --json`) || '[]');
    } catch (err) {
      console.error(`Failed to read range "${range}":`, err.message);
      return [];
    }
  }

  listSheets() {
    return JSON.parse(run(`gsheets readonly list-sheets ${this.spreadsheetId} --json`) || '[]');
  }

  listCharts() {
    try {
      const parsed = JSON.parse(run(`gsheets readonly export-chart ${this.spreadsheetId} --json`) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  addSheet(title, index) {
    const idx = index === undefined ? '' : ` --index ${index}`;
    return run(`gsheets mutate add-sheet ${this.spreadsheetId} --title "${title}"${idx}`);
  }

  renameSheet(sheetId, newTitle) {
    return run(`gsheets mutate rename-sheet ${this.spreadsheetId} --sheet-id ${sheetId} --title "${newTitle}"`);
  }

  appendRows(sheetName, rows) {
    if (!rows || rows.length === 0) return;
    return this.batch([{ op: 'append', range: `${sheetName}!A1`, data: rows }]);
  }

  writeRange(range, data) {
    return this.batch([{ op: 'write', range, data }]);
  }

  clear(range) {
    return this.batch([{ op: 'clear', range }]);
  }
}
