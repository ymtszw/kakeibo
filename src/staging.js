/**
 * Intermediate artifacts shared between the deterministic scripts and the
 * in-session classification skill. All live in ./data/staging (git-ignored).
 *
 *   evidence.json     { [primaryMessageId]: Evidence[] }   (cache, script-written)
 *   mail_cache.json   { [messageId]: MailObject }          (cache, script-written)
 *   ignored_ids.json  string[]                             (non-expense IDs)
 *   pending.json      PendingItem[]                        (script -> skill)
 *   classified.json   Classification[]                     (skill  -> script)
 *   hearing.md        human-readable list of 要ヒアリング    (script -> user)
 *   answers.json      Answer[]                             (skill, from user -> script)
 */
import fs from 'fs';
import path from 'path';

export const STAGING_DIR = path.resolve('data', 'staging');
export const FILES = {
  evidence: path.join(STAGING_DIR, 'evidence.json'),
  mailCache: path.join(STAGING_DIR, 'mail_cache.json'),
  ignored: path.join(STAGING_DIR, 'ignored_ids.json'),
  pending: path.join(STAGING_DIR, 'pending.json'),
  classified: path.join(STAGING_DIR, 'classified.json'),
  hearing: path.join(STAGING_DIR, 'hearing.md'),
  answers: path.join(STAGING_DIR, 'answers.json')
};

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8');
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf-8');
}

/** Move a consumed input aside so it is not applied twice. */
export function archive(file) {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(STAGING_DIR, 'archive');
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(file, path.join(dir, `${stamp}_${path.basename(file)}`));
}
