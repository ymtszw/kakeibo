import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { FILES, readJson, writeJson } from './staging.js';

const execAsync = promisify(exec);
const EXEC_OPTS = { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 };
const RATE_LIMIT_RE = /403|429|rateLimitExceeded|RATE_LIMIT_EXCEEDED|userRateLimitExceeded|totalQueryCostPerMinutePerUser|Too Many Requests/i;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

let _cooldownUntil = 0;
let _lastDispatchAt = 0;

async function paceDispatch(minIntervalMs = 75) {
  const now = Date.now();
  const target = Math.max(_cooldownUntil, _lastDispatchAt + minIntervalMs);
  _lastDispatchAt = target;
  if (target > now) await sleep(target - now);
}

function triggerCooldown(waitMs) {
  const until = Date.now() + waitMs;
  if (until > _cooldownUntil) _cooldownUntil = until;
}

let _sharedCache = null;
export function getSharedMailCache() {
  if (!_sharedCache) _sharedCache = readJson(FILES.mailCache, {});
  return _sharedCache;
}
export function flushSharedMailCache() {
  if (_sharedCache) writeJson(FILES.mailCache, _sharedCache);
}

export function decodeBase64(data) {
  if (!data) return '';
  const sanitized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(sanitized, 'base64').toString('utf-8');
}

export function extractBodyText(payload) {
  if (!payload) return '';
  if (payload.body && payload.body.data) {
    return decodeBase64(payload.body.data);
  }
  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        return decodeBase64(part.body.data);
      }
    }
    for (const part of payload.parts) {
      if (part.body && part.body.data) {
        return decodeBase64(part.body.data);
      }
      if (part.parts) {
        const nested = extractBodyText(part);
        if (nested) return nested;
      }
    }
  }
  return '';
}

export function getHeader(headers, name) {
  if (!headers || !Array.isArray(headers)) return '';
  const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function parseMessageItem(item) {
  if (!item || !item.id) return null;
  const headers = item.payload?.headers || [];
  const body = extractBodyText(item.payload);
  return {
    id: item.id,
    threadId: item.threadId,
    subject: getHeader(headers, 'Subject'),
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    date: getHeader(headers, 'Date'),
    internalDate: item.internalDate,
    snippet: item.snippet || '',
    body: body || item.snippet || '',
    permalink: `https://mail.google.com/mail/u/0/#inbox/${item.id}`
  };
}

/**
 * Executes a lightweight search query via gmail CLI (returns [{id, threadId}]).
 */
export function searchMessages(query, max = 50, { retries = 3 } = {}) {
  const quoted = `"${String(query).replace(/"/g, '\\"')}"`;
  const cmd = `gmail readonly search ${quoted} --max ${Number(max)} --json`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const stdout = execSync(cmd, EXEC_OPTS);
      return JSON.parse(stdout || '[]') || [];
    } catch (err) {
      const text = `${err.message || ''} ${err.stderr || ''}`;
      if (RATE_LIMIT_RE.test(text) && attempt < retries) {
        const waitMs = 15000 * (2 ** attempt);
        console.warn(`searchMessages rate-limited; waiting ${Math.round(waitMs / 1000)}s...`);
        sleepSync(waitMs);
        continue;
      }
      console.error(`searchMessages failed for query "${query}":`, err.message);
      return [];
    }
  }
  return [];
}

/**
 * Gets a single message by ID, using local mail_cache.json to avoid redundant API quota usage.
 */
export function getMessage(messageId, cache = null, { retries = 3 } = {}) {
  const c = cache || getSharedMailCache();
  if (c[messageId]) return c[messageId];
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const stdout = execSync(`gmail readonly get ${messageId} --json`, EXEC_OPTS);
      const msg = parseMessageItem(JSON.parse(stdout || '{}'));
      if (msg) c[messageId] = msg;
      return msg;
    } catch (err) {
      const text = `${err.message || ''} ${err.stderr || ''}`;
      if (RATE_LIMIT_RE.test(text) && attempt < retries) {
        const waitMs = 15000 * (2 ** attempt);
        console.warn(`getMessage rate-limited; waiting ${Math.round(waitMs / 1000)}s...`);
        sleepSync(waitMs);
        continue;
      }
      console.error(`getMessage failed for ID "${messageId}":`, err.message);
      return null;
    }
  }
  return null;
}

/**
 * Async version of getMessage with shared pacing & cooldown on rate-limit errors.
 */
export async function getMessageAsync(messageId, cache = null, { retries = 4, minIntervalMs = 80 } = {}) {
  const c = cache || getSharedMailCache();
  if (c[messageId]) return c[messageId];
  for (let attempt = 0; attempt <= retries; attempt++) {
    await paceDispatch(minIntervalMs);
    try {
      const { stdout } = await execAsync(`gmail readonly get ${messageId} --json`, EXEC_OPTS);
      const msg = parseMessageItem(JSON.parse(stdout || '{}'));
      if (msg) c[messageId] = msg;
      return msg;
    } catch (err) {
      const text = `${err.message || ''} ${err.stderr || ''}`;
      if (RATE_LIMIT_RE.test(text) && attempt < retries) {
        const waitMs = 15000 * (2 ** attempt) + Math.floor(Math.random() * 1500);
        triggerCooldown(waitMs);
        console.warn(`getMessageAsync rate-limited (${messageId}); cooling down ${Math.round(waitMs / 1000)}s...`);
        continue;
      }
      console.error(`getMessageAsync failed for ID "${messageId}":`, err.message);
      return null;
    }
  }
  return null;
}

/**
 * Quota-safe bounded-concurrency full-window mail fetcher:
 *  1. Runs `gmail readonly search` to list IDs in the target time window (1 API call).
 *  2. Skips IDs in `skipIds` (already in ledger or already ignored).
 *  3. Reads remaining messages from `mail_cache.json` first, then fetches uncached IDs
 *     via paced bounded-concurrency worker pool with shared cooldown & periodic cache flush.
 */
export async function fetchWindowMessages(query, { max = 200, skipIds = new Set(), concurrency = 5 } = {}) {
  const tSearch0 = Date.now();
  const stubs = searchMessages(query, max);
  const searchMs = Date.now() - tSearch0;

  const tFetch0 = Date.now();
  const cache = getSharedMailCache();
  let cacheHits = 0;
  let apiFetches = 0;
  const results = new Map();
  const uncachedIds = [];

  for (const stub of stubs) {
    if (!stub || !stub.id || skipIds.has(stub.id)) continue;
    if (cache[stub.id]) {
      results.set(stub.id, cache[stub.id]);
      cacheHits++;
    } else {
      uncachedIds.push(stub.id);
    }
  }

  let nextIdx = 0;
  let sinceFlush = 0;
  const workerCount = Math.max(1, Math.min(concurrency, uncachedIds.length));

  async function worker() {
    while (nextIdx < uncachedIds.length) {
      const id = uncachedIds[nextIdx++];
      const msg = await getMessageAsync(id, cache);
      if (msg) {
        results.set(id, msg);
        apiFetches++;
        sinceFlush++;
        if (sinceFlush >= 50) {
          sinceFlush = 0;
          writeJson(FILES.mailCache, cache);
        }
      }
    }
  }

  if (uncachedIds.length > 0) {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    writeJson(FILES.mailCache, cache);
  }

  const out = stubs
    .map(s => (s && s.id ? results.get(s.id) : null))
    .filter(Boolean);
  const fetchMs = Date.now() - tFetch0;
  return { totalListed: stubs.length, messages: out, searchMs, fetchMs, cacheHits, apiFetches };
}
