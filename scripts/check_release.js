#!/usr/bin/env node
/**
 * scripts/check_release.js
 * 登録済みラノベの次巻情報を openBD API で取得し、
 * release_info.json を更新するスクリプト。
 *
 * 依存: Node.js 標準モジュールのみ (https, fs, path)
 * 実行: node scripts/check_release.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const BOOKS_JSON   = path.join(__dirname, '..', 'books.json');
const OUTPUT_JSON  = path.join(__dirname, '..', 'release_info.json');
const REQUEST_WAIT_MS = 500;

/* ------------ HTTP helpers ------------ */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'ranobe-tracker-bot (github.com/oc4201124-cloud/ranobe-tracker)'
      }
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ------------ Parsing helpers ------------ */
function extractVolume(title) {
  if (!title) return null;
  // "〇〇 12巻", "〇〇 12", "〇〇12"
  let m = title.match(/(\d+)\s*巻/);
  if (m) return parseInt(m[1], 10);
  m = title.match(/[\(（]\s*(\d+)\s*[\)）]/);
  if (m) return parseInt(m[1], 10);
  // trailing number
  m = title.match(/(\d+)\s*$/);
  if (m) return parseInt(m[1], 10);
  return null;
}

function formatPubdate(pubdate) {
  if (!pubdate) return '';
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10).replace(/-/g, '');

  let y = '', m = '', d = '';
  if (pubdate.length === 8) {
    y = pubdate.slice(0, 4);
    m = parseInt(pubdate.slice(4, 6), 10);
    d = parseInt(pubdate.slice(6, 8), 10);
    const isFuture = pubdate >= todayStr;
    return isFuture
      ? `${y}年${m}月${d}日発売予定`
      : `${y}年${m}月${d}日発売`;
  }
  if (pubdate.length === 6) {
    y = pubdate.slice(0, 4);
    m = parseInt(pubdate.slice(4, 6), 10);
    const isFuture = pubdate >= todayStr.slice(0, 6);
    return isFuture
      ? `${y}年${m}月発売予定`
      : `${y}年${m}月発売`;
  }
  if (pubdate.length === 4) {
    return `${pubdate}年発売`;
  }
  return pubdate;
}

/* ------------ openBD helpers ------------ */
async function openbdSearch(title) {
  const url = `https://api.openbd.jp/v1/search?title=${encodeURIComponent(title)}&limit=20`;
  const data = await fetchJson(url);
  let isbns = [];
  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item) continue;
      if (typeof item === 'string') isbns.push(item);
      else if (item.isbn) isbns.push(item.isbn);
      else if (item.summary && item.summary.isbn) isbns.push(item.summary.isbn);
    }
  } else if (data && Array.isArray(data.hits)) {
    for (const h of data.hits) if (h && h.isbn) isbns.push(h.isbn);
  }
  return Array.from(new Set(isbns.filter(Boolean)));
}

async function openbdGet(isbns) {
  if (isbns.length === 0) return [];
  const url = `https://api.openbd.jp/v1/get?isbn=${isbns.join(',')}`;
  const data = await fetchJson(url);
  return (data || []).filter(Boolean);
}

/* ------------ Find latest volume for a title ------------ */
async function findLatest(title) {
  const isbns = await openbdSearch(title);
  if (isbns.length === 0) return null;
  await sleep(REQUEST_WAIT_MS);

  // Process in chunks of 10 to keep URL short
  const details = [];
  for (let i = 0; i < isbns.length; i += 10) {
    const chunk = isbns.slice(i, i + 10);
    const part = await openbdGet(chunk);
    details.push(...part);
    if (i + 10 < isbns.length) await sleep(REQUEST_WAIT_MS);
  }

  const candidates = [];
  for (const d of details) {
    if (!d || !d.summary) continue;
    const s = d.summary;
    if (!s.title) continue;
    // Loose title match: result title should contain the query series name
    // or vice versa (for short series titles)
    if (!s.title.includes(title) && !title.includes(s.title.replace(/\s*\d+.*$/, '').trim())) {
      continue;
    }
    candidates.push({
      isbn: s.isbn || '',
      title: s.title,
      pubdate: s.pubdate || '',
      volume: extractVolume(s.title)
    });
  }

  if (candidates.length === 0) return null;

  // Sort: latest pubdate first, then highest volume
  candidates.sort((a, b) => {
    if (a.pubdate && b.pubdate && a.pubdate !== b.pubdate) {
      return b.pubdate.localeCompare(a.pubdate);
    }
    return (b.volume || 0) - (a.volume || 0);
  });

  return candidates[0];
}

/* ------------ Main ------------ */
async function main() {
  if (!fs.existsSync(BOOKS_JSON)) {
    console.error('books.json not found at ' + BOOKS_JSON);
    process.exit(1);
  }
  const books = JSON.parse(fs.readFileSync(BOOKS_JSON, 'utf8'));
  if (!Array.isArray(books)) {
    console.error('books.json must be a JSON array of titles.');
    process.exit(1);
  }

  // Read existing release_info.json for comparison
  let existing = { updated_at: '', books: [] };
  if (fs.existsSync(OUTPUT_JSON)) {
    try { existing = JSON.parse(fs.readFileSync(OUTPUT_JSON, 'utf8')); } catch {}
  }
  const existingMap = {};
  for (const b of existing.books || []) {
    if (b && b.title) existingMap[b.title] = b;
  }

  const results = [];
  let updatedCount = 0;

  for (let i = 0; i < books.length; i++) {
    const title = books[i];
    process.stdout.write(`[${i + 1}/${books.length}] ${title} ... `);
    let latest = null;
    try {
      latest = await findLatest(title);
    } catch (e) {
      console.log('ERROR: ' + e.message);
      // Keep previous entry if we have one
      if (existingMap[title]) results.push(existingMap[title]);
      await sleep(REQUEST_WAIT_MS);
      continue;
    }

    if (!latest) {
      console.log('no match');
      if (existingMap[title]) results.push(existingMap[title]);
      await sleep(REQUEST_WAIT_MS);
      continue;
    }

    const entry = {
      title: title,
      latest_isbn: latest.isbn || '',
      latest_vol: latest.volume != null ? String(latest.volume) : '',
      pubdate: latest.pubdate || '',
      pubdate_display: formatPubdate(latest.pubdate)
    };

    const prev = existingMap[title];
    if (!prev || prev.pubdate !== entry.pubdate || prev.latest_isbn !== entry.latest_isbn) {
      updatedCount++;
      console.log(`updated (${entry.latest_vol || '?'} 巻 / ${entry.pubdate || '発売日不明'})`);
    } else {
      console.log('no change');
    }
    results.push(entry);
    await sleep(REQUEST_WAIT_MS);
  }

  const output = {
    updated_at: new Date().toISOString(),
    books: results
  };
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`\nDone. ${updatedCount} updated / ${results.length} total`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
