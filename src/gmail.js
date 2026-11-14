import { execSync } from 'child_process';
import { FILES, readJson, writeJson } from './staging.js';

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

/**
 * Executes a lightweight search query via gmail CLI (returns [{id, threadId}]).
 */
export function searchMessages(query, max = 50) {
  try {
    const escaped = query.replace(/'/g, "''");
    const cmd = `gmail readonly search '${escaped}' --max ${max} --json`;
    const stdout = execSync(cmd, { shell: 'powershell', encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(stdout || '[]') || [];
  } catch (err) {
    console.error(`searchMessages failed for query "${query}":`, err.message);
    return [];
  }
}

/**
 * Gets a single message by ID, using local mail_cache.json to avoid redundant API quota usage.
 */
export function getMessage(messageId, cache = null) {
  if (cache && cache[messageId]) return cache[messageId];
  try {
    const cmd = `gmail readonly get ${messageId} --json`;
    const stdout = execSync(cmd, { shell: 'powershell', encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    const item = JSON.parse(stdout || '{}');
    if (!item || !item.id) return null;
    const headers = item.payload?.headers || [];
    const body = extractBodyText(item.payload);
    const msg = {
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
    if (cache) cache[messageId] = msg;
    return msg;
  } catch (err) {
    console.error(`getMessage failed for ID "${messageId}":`, err.message);
    return null;
  }
}

/**
 * Quota-safe full-window mail fetcher:
 *  1. Runs `gmail readonly search` to list IDs in the target time window (1 API call).
 *  2. Skips IDs in `skipIds` (already in ledger or already ignored).
 *  3. Reads remaining messages using `mail_cache.json` + sequential `getMessage`
 *     so it never triggers Gmail's per-minute concurrency rate limit.
 */
export function fetchWindowMessages(query, { max = 200, skipIds = new Set() } = {}) {
  const tSearch0 = Date.now();
  const stubs = searchMessages(query, max);
  const searchMs = Date.now() - tSearch0;

  const tFetch0 = Date.now();
  const cache = readJson(FILES.mailCache, {});
  let dirty = false;
  let cacheHits = 0;
  let apiFetches = 0;
  const out = [];

  for (const stub of stubs) {
    if (!stub || !stub.id || skipIds.has(stub.id)) continue;
    const wasCached = Boolean(cache[stub.id]);
    const msg = getMessage(stub.id, cache);
    if (msg) {
      out.push(msg);
      if (wasCached) cacheHits++;
      else { apiFetches++; dirty = true; }
    }
  }
  if (dirty) writeJson(FILES.mailCache, cache);
  const fetchMs = Date.now() - tFetch0;
  return { totalListed: stubs.length, messages: out, searchMs, fetchMs, cacheHits, apiFetches };
}
