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
function fetchText(url, acceptHeader) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Accept': acceptHeader || '*/*',
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
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('Request timeout')); });
  });
}

async function fetchJson(url) {
  const text = await fetchText(url, 'application/json');
  try { return JSON.parse(text); }
  catch (e) { throw new Error('JSON parse error: ' + e.message); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ------------ Parsing helpers ------------ */
/* 句読点・空白を除去して比較用に正規化 */
function normalizeTitle(s) {
  if (!s) return '';
  return s
    .replace(/[\s\u3000]+/g, '')
    .replace(/[、。・!?！？,.\-―ー~〜「」『』【】〈〉《》\(\)（）\[\]]/g, '')
    .toLowerCase();
}

function extractVolume(title) {
  if (!title) return null;
  // "〇〇 12巻" "第12巻"
  let m = title.match(/第?\s*(\d+)\s*巻/);
  if (m) return parseInt(m[1], 10);
  // "(12)" "（12）"
  m = title.match(/[\(（]\s*(\d+)\s*[\)）]/);
  if (m) return parseInt(m[1], 10);
  // 全角数字
  const zen = '０１２３４５６７８９';
  const zenM = title.match(/[０-９]+/);
  if (zenM) {
    let n = 0;
    for (const c of zenM[0]) n = n * 10 + zen.indexOf(c);
    if (n > 0) return n;
  }
  // trailing or isolated number near end (after space/symbol)
  m = title.match(/[\s　・]+(\d+)(?:\s|$)/);
  if (m) return parseInt(m[1], 10);
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

/* ------------ NDL opensearch & openBD ------------ */
// openBD にはタイトル検索エンドポイントがないため、NDLサーチから取得する
// <item>要素を解析して title/pubDate/ISBN を抽出する
function parseNdlItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let im;
  while ((im = itemRe.exec(xml)) !== null) {
    const chunk = im[1];
    const titleM = chunk.match(/<title>([^<]+)<\/title>/);
    const pubDateM = chunk.match(/<pubDate>([^<]+)<\/pubDate>/);
    const dcDateM = chunk.match(/<dc:date[^>]*>([^<]+)<\/dc:date>/);
    const isbnM = chunk.match(/<dc:identifier[^>]*ISBN[^>]*>([0-9X\-]+)<\/dc:identifier>/i);
    items.push({
      title: titleM ? titleM[1] : '',
      pubDateRaw: pubDateM ? pubDateM[1] : '',
      dcDate: dcDateM ? dcDateM[1] : '', // e.g. "2024-05-23"
      isbn: isbnM ? isbnM[1].replace(/[-\s]/g, '') : ''
    });
  }
  return items;
}

async function ndlSearch(title) {
  const url = `https://ndlsearch.ndl.go.jp/api/opensearch?title=${encodeURIComponent(title)}&cnt=50`;
  const xml = await fetchText(url, 'application/xml, text/xml, */*');
  return parseNdlItems(xml);
}

async function openbdGet(isbns) {
  if (isbns.length === 0) return [];
  const url = `https://api.openbd.jp/v1/get?isbn=${isbns.join(',')}`;
  const data = await fetchJson(url);
  return (data || []).filter(Boolean);
}

/* dc:date "2024-05-23" → "20240523" */
function dcDateToPubdate(d) {
  if (!d) return '';
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + m[2] + m[3];
  const y = d.match(/^(\d{4})-(\d{2})/);
  if (y) return y[1] + y[2];
  return '';
}

/* 常に除外したいフォーマット(音楽・映像) */
function isHardExcluded(title) {
  if (!title) return true;
  return /オーディオブック|朗読|サウンドトラック|カヴァー|カバー曲|主題歌|オープニング|エンディング|アニソン|OST|blu-?ray|dvd|b-side/i.test(title);
}
/* 電子分冊版・合本版などの「フォールバック扱い」フォーマット */
function isDigitalOnly(title) {
  if (!title) return false;
  return /【分冊版】|【合本版】|分冊版|合本版/.test(title);
}

/* ------------ Find latest volume for a title ------------ */
async function findLatest(title) {
  const items = await ndlSearch(title);
  if (items.length === 0) return null;

  const normQuery = normalizeTitle(title);
  const preferred = []; // 物理書籍
  const fallback = []; // 電子分冊版などの代替
  for (const it of items) {
    if (!it.title) continue;
    if (isHardExcluded(it.title)) continue;
    const normResult = normalizeTitle(it.title);
    // 正規化後にクエリを含んでいる or クエリが結果(巻数除去後)を含む
    const resultNoVol = normResult.replace(/\d+.*$/, '');
    if (!normResult.includes(normQuery) && !(resultNoVol && normQuery.includes(resultNoVol))) {
      continue;
    }
    const entry = {
      isbn: it.isbn,
      title: it.title,
      pubdate: dcDateToPubdate(it.dcDate),
      volume: extractVolume(it.title)
    };
    if (isDigitalOnly(it.title)) fallback.push(entry);
    else preferred.push(entry);
  }

  let candidates;
  let isDigitalFallback = false;
  if (preferred.length > 0) {
    candidates = preferred;
  } else {
    candidates = fallback;
    isDigitalFallback = true;
  }
  if (candidates.length === 0) return null;

  // Sort: latest pubdate first, then highest volume
  candidates.sort((a, b) => {
    if (a.pubdate && b.pubdate && a.pubdate !== b.pubdate) {
      return b.pubdate.localeCompare(a.pubdate);
    }
    return (b.volume || 0) - (a.volume || 0);
  });

  const top = candidates[0];
  if (isDigitalFallback) {
    // 分冊版の"巻数"は実巻数ではないので無効化
    top.volume = null;
  }

  // ISBNがあれば openBD で詳細データ(特に正確な pubdate)を取得して上書き
  if (top.isbn) {
    try {
      await sleep(REQUEST_WAIT_MS);
      const details = await openbdGet([top.isbn]);
      if (details.length > 0 && details[0].summary) {
        const s = details[0].summary;
        if (s.pubdate) top.pubdate = s.pubdate;
        if (s.title) top.title = s.title;
      }
    } catch (e) {
      // openBD失敗は無視(NDLデータで続行)
    }
  }

  return top;
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
