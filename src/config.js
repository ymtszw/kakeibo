import fs from 'fs';

// Load repo-root .env (git-ignored) so CLI and scheduled runs share the same settings.
const envPath = new URL('../.env', import.meta.url);
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

export const CONFIG = {
  SPREADSHEET_ID: process.env.KAKEIBO_SPREADSHEET_ID || "",
  SHEETS: {
    DASHBOARD: "ダッシュボード",
    KNOWLEDGE: "ナレッジベース",
    EXCLUSIONS: "除外ドメイン",
    LEDGER_2026: "2026年"
  },
  CONFIDENCE_THRESHOLD: 0.8,
  MAX_RETRIES: 2,
  SEARCH_WINDOW_HOURS: 2
};
