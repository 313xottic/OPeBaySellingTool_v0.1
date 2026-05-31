'use strict';

const express = require('express');
const fs      = require('fs');
const fsp     = fs.promises;
const path    = require('path');
const https   = require('https');
const http    = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Directory layout ─────────────────────────────────────────────────────────
const DATA_DIR    = path.join(__dirname, 'data');
const SETS_DIR    = path.join(DATA_DIR, 'sets');
const IMAGES_DIR  = path.join(DATA_DIR, 'img-cache');   // locally-cached rounded TCGPlayer images
const STATE_FILE  = path.join(DATA_DIR, 'update-state.json');
const IMG_CACHE_FILE = path.join(DATA_DIR, 'img-cache.json'); // { productId: '/img-cache/pid.png' | false }
const USERS_FILE  = path.join(DATA_DIR, 'users.json');        // [{username,email,passwordHash,...}]

for (const d of [DATA_DIR, SETS_DIR, IMAGES_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

app.use(express.json({ limit: '20mb' }));

// ── CORS — allow the Cloudflare Pages frontend to call this server ────────────
// In production set ALLOWED_ORIGIN to your Pages URL, e.g.:
//   ALLOWED_ORIGIN=https://tcg-marketplace.pages.dev npm start
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
// Serve locally-cached rounded TCGPlayer images
app.use('/img-cache', express.static(IMAGES_DIR));

// Explicit fallback so 'Cannot GET /' never appears
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── CSV utilities ─────────────────────────────────────────────────────────────
function parseCSV(text) {
  if (!text || !text.trim()) return [];
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], nx = text[i + 1];
    if (inQ) {
      if (ch === '"' && nx === '"') { field += '"'; i++; }
      else if (ch === '"') inQ = false;
      else field += ch;
    } else {
      if (ch === '"')  { inQ = true; }
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && nx === '\n') i++;
        row.push(field); field = '';
        if (row.some(v => v !== '')) rows.push(row);
        row = [];
      } else field += ch;
    }
  }
  if (field || row.length) { row.push(field); if (row.some(v => v !== '')) rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (r[i] || '').trim(); });
    return obj;
  });
}

function toCSV(rows) {
  if (!rows || !rows.length) return '';
  // Collect ALL column names across every row (preserving first-seen order).
  // Critical: different products have different ext* columns, so we can't
  // rely on rows[0] alone — it may have no ext* columns at all.
  const headerSet = new Set();
  for (const row of rows) for (const k of Object.keys(row)) headerSet.add(k);
  const headers = [...headerSet];
  const esc = v => {
    const s = v == null ? '' : String(v);
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  };
  return [
    headers.join(','),
    ...rows.map(r => headers.map(h => esc(r[h])).join(','))
  ].join('\n');
}

// ── File I/O helpers ──────────────────────────────────────────────────────────
async function readJSON(file, def = {}) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch { return def; }
}
async function writeJSON(file, data) {
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}
async function readCSVFile(file) {
  try { return parseCSV(await fsp.readFile(file, 'utf8')); }
  catch { return []; }
}
async function writeCSVFile(file, rows) {
  await fsp.writeFile(file, toCSV(rows), 'utf8');
}

// ── HTTP fetch (no external deps) ─────────────────────────────────────────────
function fetchText(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'TCGMarketplace/2.0' } }, resp => {
      if (resp.statusCode !== 200) {
        resp.resume();
        reject(new Error(`HTTP ${resp.statusCode} — ${url}`));
        return;
      }
      let buf = '';
      resp.setEncoding('utf8');
      resp.on('data', c => buf += c);
      resp.on('end',  () => resolve(buf));
      resp.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

// ── Binary HTTP fetch (for image downloads) ───────────────────────────────────
function fetchBuffer(url, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const reqOpts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      }
    };
    const req = mod.get(url, reqOpts, resp => {
      if (resp.statusCode === 301 || resp.statusCode === 302) {
        resp.resume();
        const loc = resp.headers.location;
        if (!loc) return reject(new Error('Redirect with no location'));
        return fetchBuffer(loc, timeoutMs).then(resolve).catch(reject);
      }
      if (resp.statusCode !== 200) {
        resp.resume();
        return reject(new Error(`HTTP ${resp.statusCode}`));
      }
      const chunks = [];
      resp.on('data',  c => chunks.push(c));
      resp.on('end',   () => resolve(Buffer.concat(chunks)));
      resp.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CORNER RADIUS — Based on real One Piece TCG card specs: 3mm radius on 88mm tall card
//   = 3 ÷ 88 = 0.034  →  34px at CARD_H=1000
//   0.025 = very subtle  |  0.034 = accurate card match (default)  |  0.055 = noticeably round
// ─────────────────────────────────────────────────────────────────────────────
const CORNER_RADIUS_RATIO = 0.034; // ← CORNER_RADIUS: change this number to adjust rounding

// Card dimensions — portrait ratio matching One Piece TCG cards (aspect ratio 0.716)
// TCGPlayer's _in_1000x1000 images are square with padding; cover-cropping to CARD_W×CARD_H
// trims the padding and produces the correct card shape.
const CARD_W = 716;  // ← width  in pixels (change both if you want a different output size)
const CARD_H = 1000; // ← height in pixels

async function applyRoundedCorners(inputBuffer) {
  let sharp;
  try { sharp = require('sharp'); }
  catch(e) { throw new Error('sharp not installed — run: npm install sharp'); }

  const radius = Math.round(CARD_H * CORNER_RADIUS_RATIO); // e.g. 47px at default 0.047

  // SVG rounded-rect mask: white inside, transparent outside.
  // sharp's 'dest-in' composite keeps only pixels where the mask is opaque,
  // so corners become transparent in the output PNG (no white fill).
  const mask = Buffer.from(
    `<svg width="${CARD_W}" height="${CARD_H}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="0" y="0" width="${CARD_W}" height="${CARD_H}" rx="${radius}" ry="${radius}" fill="white"/>` +
    `</svg>`
  );

  return sharp(inputBuffer)
    .resize(CARD_W, CARD_H, { fit: 'cover', position: 'centre' }) // crop square padding → card ratio
    .png()                                                          // PNG preserves transparency
    .composite([{ input: mask, blend: 'dest-in' }])                // corners → transparent
    .toBuffer();
}

// ── TCGPlayer image processing ────────────────────────────────────────────────
// Downloads each product's TCGPlayer 1000×1000 image, rounds the corners,
// saves as a local PNG, then writes the path into customImageUrl in the CSV.
//
// img-cache.json is kept ONLY for:
//   - __version: cache-bust key (bump to reprocess all)
//   - productId: false — confirmed TCGPlayer placeholder/404, don't retry
//
// Success tracking: check whether data/img-cache/{pid}.png already exists on disk.
// TCGPlayer's "Image Coming Soon" placeholder is LANDSCAPE (e.g. 1000×573).
// Real card images are always portrait. Detected by: width >= height = placeholder.
let imgProcessRunning = false;
let imgProcessLog     = '';
let imgProcessDone    = 0;
let imgProcessTotal   = 0;

function isPlaceholderImage(metadata) {
  return metadata.width >= metadata.height;
}

async function processProductImages() {
  if (imgProcessRunning) return;
  imgProcessRunning = true;
  imgProcessDone    = 0;
  imgProcessLog     = 'Building product list…';

  try {
    await fsp.mkdir(IMAGES_DIR, { recursive: true });
    // img-cache.json only holds failures (false) + version — NOT success paths
    const failCache = await readJSON(IMG_CACHE_FILE, {});

    // Version check — bump CACHE_VERSION to wipe all local PNGs and reprocess
    const CACHE_VERSION = 'v3-716x1000-r034';
    if (failCache.__version !== CACHE_VERSION) {
      console.log(`[imgProcess] Cache version mismatch (${failCache.__version} → ${CACHE_VERSION}), clearing cached images`);
      try {
        const oldFiles = await fsp.readdir(IMAGES_DIR);
        for (const f of oldFiles) {
          if (f.endsWith('.png')) await fsp.unlink(path.join(IMAGES_DIR, f)).catch(() => {});
        }
      } catch {}
      for (const k of Object.keys(failCache)) delete failCache[k];
      failCache.__version = CACHE_VERSION;
      await writeJSON(IMG_CACHE_FILE, failCache);
    }

    const sets = await getLocalSets();

    // Collect unique productIds still needing processing
    // Skip sealed products — no corner rounding for box/pack art
    const toProcess = [];
    const seenPids  = new Set();
    for (const s of sets) {
      const prods = await readCSVFile(path.join(setDir(s.groupId), 'products.csv'));
      for (const row of prods) {
        const pid = String(parseInt(row.productId) || 0);
        if (!pid || pid === '0' || seenPids.has(pid)) continue;
        if (!row.name || !row.name.trim()) continue;
        seenPids.add(pid);
        if (pid === '__version') continue;
        if (row.customImageUrl) continue;              // user image OR already saved by us
        if (failCache[pid] === false) continue;        // confirmed placeholder/404, skip

        // Skip sealed (no rounding for box/pack art)
        const ctVal     = (row.extCardType || '').trim().toUpperCase();
        const rowSerial = (row.extNumber   || '').trim();
        const hasSerial = !!(rowSerial && /^(OP|ST|EB|P|PRB)/i.test(rowSerial));
        const isDon     = ctVal === 'DON!!';
        const isCard    = hasSerial || ctVal === 'CHARACTER' || ctVal === 'LEADER';
        if (!isDon && !isCard) continue;

        // Skip if PNG already on disk (success already written to CSV in a prior run)
        const localPath = path.join(IMAGES_DIR, `${pid}.png`);
        try { await fsp.access(localPath); continue; } catch {}

        toProcess.push({ pid, name: (row.name || '').trim() });
      }
    }

    imgProcessTotal = toProcess.length;
    console.log(`[imgProcess] ${toProcess.length} products to process`);

    if (!toProcess.length) {
      imgProcessLog     = 'All images already cached';
      imgProcessRunning = false;
      return;
    }

    let sharp;
    try { sharp = require('sharp'); } catch(e) { throw new Error('sharp not installed — run: npm install sharp'); }

    let saved = 0, placeholder = 0, failed = 0;
    for (let i = 0; i < toProcess.length; i++) {
      const { pid, name } = toProcess[i];
      const localPath = path.join(IMAGES_DIR, `${pid}.png`);
      const tcgUrl    = `https://tcgplayer-cdn.tcgplayer.com/product/${pid}_in_1000x1000.jpg`;
      imgProcessLog   = `Processing ${i + 1}/${toProcess.length}: ${name}`;

      try {
        const buf  = await fetchBuffer(tcgUrl, 20000);

        // ── Placeholder detection ─────────────────────────────────────────────
        // TCGPlayer "Image Coming Soon" is landscape (1000×573). Cards are portrait.
        const meta = await sharp(buf).metadata();
        if (isPlaceholderImage(meta)) {
          failCache[pid] = false; // mark as no-image, don't retry
          placeholder++;
          console.log(`[imgProcess] ⊘ ${pid} "${name}": TCGPlayer placeholder (${meta.width}×${meta.height})`);
        } else {
          // ── Round corners + save PNG ────────────────────────────────────────
          const rounded = await applyRoundedCorners(buf);
          await fsp.writeFile(localPath, rounded);
          // Write path directly into CSV's customImageUrl column
          await findAndUpdateProductRow(pid, { customImageUrl: `/img-cache/${pid}.png` });
          saved++;
          console.log(`[imgProcess] ✓ ${pid} "${name}"`);
        }
      } catch(e) {
        failCache[pid] = false; // 404 or network error — don't retry
        failed++;
        console.log(`[imgProcess] ✗ ${pid} "${name}": ${e.message}`);
      }

      imgProcessDone = i + 1;
      if (i % 50 === 49) await writeJSON(IMG_CACHE_FILE, failCache);
      await new Promise(r => setTimeout(r, 120)); // gentle rate limiting
    }

    await writeJSON(IMG_CACHE_FILE, failCache);
    dbCache = null;
    imgProcessLog = `Done — ${saved} saved, ${placeholder} TCGPlayer placeholders, ${failed} errors`;
    console.log('[imgProcess]', imgProcessLog);
  } catch(e) {
    imgProcessLog = 'Error: ' + e.message;
    console.error('[imgProcess]', e.message);
  }

  imgProcessRunning = false;
}

// ── State helpers ─────────────────────────────────────────────────────────────
async function getState() {
  return readJSON(STATE_FILE, {
    lastUpdatedTxt: '',
    lastChecked:    0,
    pendingUpdateAt: 0,
    lastUpdatedAt:  0
  });
}
async function saveState(s) { await writeJSON(STATE_FILE, s); }

// ── Set directory helpers ─────────────────────────────────────────────────────
async function getLocalSets() {
  try {
    const dirs = await fsp.readdir(SETS_DIR);
    const sets = [];
    for (const d of dirs) {
      const meta = await readJSON(path.join(SETS_DIR, d, 'meta.json'), null);
      if (meta && meta.groupId) sets.push(meta);
    }
    return sets.sort((a, b) => String(a.groupId).localeCompare(String(b.groupId)));
  } catch { return []; }
}

function setDir(groupId) { return path.join(SETS_DIR, String(groupId)); }

// ── JSON fetch helpers ────────────────────────────────────────────────────────

// Fetch a TCGCSV endpoint and return the results array.
// Always returns a plain array of plain objects (never nested).
async function fetchTCGJson(url) {
  const txt = await fetchText(url);
  let parsed;
  try { parsed = JSON.parse(txt); } catch (e) {
    throw new Error(`Non-JSON response from ${url}: ${txt.substring(0, 80)}`);
  }
  return Array.isArray(parsed) ? parsed : (parsed.results || parsed.data || []);
}

// Flatten one products JSON item into a flat CSV-compatible row.
// extendedData array → ext{Name} columns (same schema the old tcgcsv CSVs used).
function flattenProduct(p) {
  const row = {
    productId:  String(p.productId),
    name:       p.name       || '',
    cleanName:  p.cleanName  || '',
    imageUrl:   p.imageUrl   || '',
    categoryId: String(p.categoryId || ''),
    groupId:    String(p.groupId    || ''),
    url:        p.url        || '',
    modifiedOn: p.modifiedOn || '',
  };
  // Flatten extendedData: [{name:'Rarity', value:'R'}, ...] → extRarity:'R'
  if (Array.isArray(p.extendedData)) {
    for (const e of p.extendedData) {
      if (e && e.name) row['ext' + e.name] = e.value != null ? String(e.value) : '';
    }
  }
  return row;
}

// Flatten one prices JSON item into a plain row.
function flattenPrice(p) {
  return {
    productId:     String(p.productId),
    lowPrice:      p.lowPrice      != null ? String(p.lowPrice)      : '',
    midPrice:      p.midPrice      != null ? String(p.midPrice)      : '',
    highPrice:     p.highPrice     != null ? String(p.highPrice)     : '',
    marketPrice:   p.marketPrice   != null ? String(p.marketPrice)   : '',
    directLowPrice:p.directLowPrice != null ? String(p.directLowPrice) : '',
    subTypeName:   p.subTypeName   || '',
  };
}

// ── Incremental set update ────────────────────────────────────────────────────
//
//   Products CSV: only ADD rows whose productId is not already in the file.
//                 Never overwrite — preserves manual corrections.
//   Prices  CSV: add new (productId+subTypeName) combos; update price fields
//                for existing ones from latest TCGCSV data.
//
async function updateSet(groupId, setName) {
  const dir = setDir(groupId);
  await fsp.mkdir(dir, { recursive: true });

  // ── Fetch from TCGCSV ──
  let rawProds, rawPrices;
  try {
    [rawProds, rawPrices] = await Promise.all([
      fetchTCGJson(`https://tcgcsv.com/tcgplayer/68/${groupId}/products`),
      fetchTCGJson(`https://tcgcsv.com/tcgplayer/68/${groupId}/prices`),
    ]);
  } catch (e) {
    console.warn(`  [set ${groupId}] fetch failed: ${e.message}`);
    return false;
  }

  if (!rawProds || !rawProds.length) {
    console.warn(`  [set ${groupId}] empty products, skipping`);
    return false;
  }

  const newProds  = rawProds.map(flattenProduct);
  const newPrices = (rawPrices || []).map(flattenPrice);

  // ── Products: add-only (keyed by productId string) ──
  // Deduplicate existing rows first — keeps first occurrence (which has any manual edits)
  const rawExistProds = await readCSVFile(path.join(dir, 'products.csv'));
  const seenPids = new Set();
  const existProds = rawExistProds.filter(p => {
    const k = String(p.productId);
    if (seenPids.has(k)) return false;
    seenPids.add(k);
    return true;
  });
  const existPidSet = new Set(existProds.map(p => String(p.productId)));
  const mergedProds = [...existProds];
  let addedProds = 0;
  for (const p of newProds) {
    if (!existPidSet.has(p.productId)) {
      mergedProds.push(p);
      existPidSet.add(p.productId);
      addedProds++;
    }
    // Never overwrite — manual corrections survive.
  }

  // ── Prices: add new; update price fields for existing ──
  const priceKey    = p => `${p.productId}__${p.subTypeName || ''}`;
  const existPrices = await readCSVFile(path.join(dir, 'prices.csv'));
  const priceMap    = new Map(existPrices.map(p => [priceKey(p), p]));
  const mergedPrices = [...existPrices];
  let addedPrices = 0;
  for (const p of newPrices) {
    const k = priceKey(p);
    if (priceMap.has(k)) {
      // Update price fields only
      const ex = priceMap.get(k);
      for (const f of ['lowPrice','midPrice','highPrice','marketPrice','directLowPrice']) {
        if (p[f] !== undefined && p[f] !== '') ex[f] = p[f];
      }
    } else {
      mergedPrices.push(p);
      priceMap.set(k, p);
      addedPrices++;
    }
  }

  await writeCSVFile(path.join(dir, 'products.csv'), mergedProds);
  await writeCSVFile(path.join(dir, 'prices.csv'),   mergedPrices);
  await writeJSON(path.join(dir, 'meta.json'), {
    groupId:   String(groupId),
    name:      setName,
    updatedAt: Date.now()
  });

  if (addedProds || addedPrices) {
    console.log(`  [set ${groupId}] +${addedProds} products, +${addedPrices} prices`);
  }
  return true;
}

// ── Full incremental update ───────────────────────────────────────────────────
let updateRunning = false;
let updateLog     = '';
let lastEditAt    = 0;  // bumped on any edit that changes CSV data

async function runUpdate() {
  if (updateRunning) return;
  updateRunning = true;
  updateLog     = 'Fetching groups...';
  console.log('[update] Started');

  try {
    // fetchTCGJson handles JSON envelope (results array) automatically
    const rawGroups = await fetchTCGJson('https://tcgcsv.com/tcgplayer/68/groups');
    console.log('[update] groups raw sample:', JSON.stringify(rawGroups[0] || {}));
    const groups = rawGroups.map(g => ({
      groupId: g.groupId || g.GroupID || g.group_id || g.id,
      name:    g.name    || g.Name    || g.groupName || g.setName || ''
    })).filter(g => g.groupId && g.name);
    if (!groups.length) throw new Error('Zero groups returned from TCGCSV');
    updateLog = `Updating ${groups.length} sets…`;
    console.log(`[update] ${groups.length} groups total`);

    const BATCH = 4;
    let done = 0;
    for (let i = 0; i < groups.length; i += BATCH) {
      const batch = groups.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(g => updateSet(g.groupId, g.name)));
      done += batch.length;
      updateLog = `${done}/${groups.length} sets done`;
      console.log(`[update] ${done}/${groups.length}`);
    }

    dbCache = null; // Invalidate in-memory cache
    const state = await getState();
    state.lastUpdatedAt = Date.now();
    await saveState(state);

    updateLog = `Complete — ${groups.length} sets`;
    console.log('[update] Done');
    // Scrape prices for any products missing them
    setTimeout(scrapeMissingPrices, 2000);
    // Download + round corners for any new TCGPlayer images
    setTimeout(processProductImages, 8000);
  } catch (e) {
    updateLog = 'Error: ' + e.message;
    console.error('[update] Error:', e.message);
  }

  updateRunning = false;
  setTimeout(() => { if (!updateRunning) updateLog = ''; }, 15000);
}

// ── Background update checker (polls last-updated.txt) ───────────────────────
async function checkForUpdates() {
  const state = await getState();
  const now   = Date.now();

  // A scheduled update is ready — run it
  if (state.pendingUpdateAt && now >= state.pendingUpdateAt) {
    state.pendingUpdateAt = 0;
    await saveState(state);
    runUpdate();
    return;
  }

  // Not time to trigger yet — just check the timestamp
  try {
    const txt = (await fetchText('https://tcgcsv.com/last-updated.txt')).trim();
    state.lastChecked = now;
    if (txt && txt !== state.lastUpdatedTxt && !state.pendingUpdateAt && !updateRunning) {
      console.log(`[update] TCGCSV changed (${txt}), scheduling in 5 min`);
      state.lastUpdatedTxt    = txt;
      state.pendingUpdateAt   = now + 5 * 60 * 1000;
    }
    await saveState(state);
  } catch { /* network hiccup — try again next cycle */ }
}

// ── DB builder (reads local CSVs → returns JSON for the frontend) ─────────────
let dbCache = null;

const DNAMES = {
  CardType:   'Card Type',
  Subtypes:   'Subtype(s)',
  Counterplus:'Counter+',
  CardEffect: 'Effect',
  BlockIcon:  'Block',
  FlavorText: 'Flavor Text'
};
const SERIAL_RE = /\b((?:OP|ST|EB|P|PRB)\d{0,2}-\d{3,}[A-Z]?)\b/i;

async function buildDB() {
  if (dbCache) return dbCache;

  const sets = await getLocalSets();

  const allCards = [], sealed = [], don = [];
  const cardMapObj = {};
  const byUidObj   = {};

  const globalSeenPids = new Set(); // cross-set dedup guard

  for (const setMeta of sets) {
    const dir    = setDir(setMeta.groupId);
    let prods, prices;
    try {
      prods  = await readCSVFile(path.join(dir, 'products.csv'));
      prices = await readCSVFile(path.join(dir, 'prices.csv'));
      // Remove intra-set duplicates (same productId twice in one file)
      const seen = new Set();
      prods = prods.filter(p => {
        const k = String(p.productId);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    } catch (e) {
      console.warn(`[buildDB] Could not read set ${setMeta.groupId}: ${e.message}`);
      continue;
    }

    // Skip sets that were saved with the old broken format
    if (prods.length && prods[0] && String(prods[0].extendedData || '').includes('object')) {
      console.warn(`[buildDB] Set ${setMeta.groupId} has corrupt extendedData, skipping — re-run update`);
      continue;
    }

    // Build price lookup: productId → { subTypeName → row }
    const priceMap = {};
    for (const p of prices) {
      if (!priceMap[p.productId]) priceMap[p.productId] = {};
      priceMap[p.productId][p.subTypeName || ''] = p;
    }

    for (const row of prods) {
      if (!row.name || !row.name.trim()) continue;
      if (globalSeenPids.has(String(parseInt(row.productId)||0))) continue;
      try {
      const pid    = parseInt(row.productId) || 0;
      globalSeenPids.add(String(pid));
      const pidStr = String(pid);

      // Build extendedData from ext* columns
      const ext = [];
      for (const k of Object.keys(row)) {
        if (k.startsWith('ext') && k.length > 3 && row[k] && row[k].trim()) {
          const fn = k.slice(3);
          ext.push({
            name:        fn,
            displayName: DNAMES[fn] || fn.replace(/([A-Z])/g, ' $1').trim(),
            value:       row[k].trim()
          });
        }
      }

      const nm = row.name.trim();
      let serial = (row.extNumber || '').trim();
      if (!serial) { const e = ext.find(e => e.name === 'Number'); if (e) serial = e.value.trim(); }
      if (!serial) { const m = nm.match(SERIAL_RE); if (m) serial = m[1]; }

      const ctExt  = ext.find(e => e.name === 'CardType' && e.value);
      const ctVal  = ctExt ? ctExt.value.trim().toUpperCase() : '';
      const isDon  = ctVal === 'DON!!';
      const hasSerial = !!(serial && /^(OP|ST|EB|P|PRB)/i.test(serial));
      const isCard = hasSerial || ctVal === 'CHARACTER' || ctVal === 'LEADER';
      const type   = isDon ? 'don' : (isCard ? 'card' : 'sealed');

      const customImg = row.customImageUrl || null;
      const priceRows = priceMap[pidStr] ? Object.values(priceMap[pidStr]) : [];
      const splitVar  = priceRows.length > 1;
      const rarityExt = ext.find(e => e.name === 'Rarity');

      const getMP = pr => pr
        ? (parseFloat(pr.marketPrice) || parseFloat(pr.midPrice) || parseFloat(pr.lowPrice) || 0)
        : 0;

      if (type === 'sealed') {
        const uid  = pidStr;
        const item = {
          productId: pid, uid, variant: null, name: nm,
          marketPrice: getMP(priceRows[0]),
          setName: setMeta.name, extendedData: ext, type: 'sealed',
          customImage: customImg
        };
        sealed.push(item);
        byUidObj[uid] = item;

      } else {
        const varList = splitVar ? priceRows : [priceRows[0] || null];
        for (const pr of varList) {
          const sub     = pr ? (pr.subTypeName || '').trim() : '';
          const variant = sub || null;
          const uid     = splitVar ? `${pidStr}_${sub}` : pidStr;

          const item = {
            productId: pid, uid, variant, name: nm,
            marketPrice: getMP(pr),
            setName: setMeta.name, extendedData: ext, type,
            customImage: customImg,
            isSplit: splitVar,  // true when both Normal+Foil variants exist for this productId
            ...(type === 'card' ? {
              rarity: (row.extRarity || (rarityExt ? rarityExt.value : '')) || '',
              number: serial ? serial.toUpperCase() : `NO-SERIAL-${pid}`
            } : {})
          };

          byUidObj[uid] = item;
          if (type === 'card') {
            const num = item.number;
            if (!cardMapObj[num]) cardMapObj[num] = [];
            cardMapObj[num].push(item);
            allCards.push(item);
          } else {
            don.push(item);
          }
        }
      }
      } catch(rowErr) {
        console.warn(`[buildDB] Skipping row in set ${setMeta.groupId}: ${rowErr.message}`);
      }
    }
  }

  console.log(`[buildDB] Built: ${allCards.length} cards, ${sealed.length} sealed, ${don.length} DON!!`);
  dbCache = { cardMapObj, byUidObj, sealed, don, allCards };
  return dbCache;
}

// ── Edit issues builder ───────────────────────────────────────────────────────
async function buildEditIssues() {
  const sets  = await getLocalSets();
  const issues = [];

  for (const setMeta of sets) {
    try {
    const dir      = setDir(setMeta.groupId);
    const prods    = await readCSVFile(path.join(dir, 'products.csv'));
    const prices   = await readCSVFile(path.join(dir, 'prices.csv'));
    const pricePids = new Set(prices.map(p => String(p.productId)));

    for (const row of prods) {
      if (!row.name || !row.name.trim()) continue;
      const pid            = String(parseInt(row.productId) || 0);
      const hasManualPrice = pricePids.has(pid);
      const hasCustomImage = !!(row.customImageUrl);
      const isCompleted    = row.editCompleted === '1';

      const tags = [];
      if (!pricePids.has(pid) && !hasManualPrice)
        tags.push('no-price');
      // image-not-updated: no image saved (TCGPlayer processed ones write to customImageUrl)
      if (!hasCustomImage)
        tags.push('image-not-updated');
      // Flag cards/don with price rows that have no Normal or Foil subTypeName
      const ctVal = (row.extCardType || '').trim().toUpperCase();
      const rowSerial = (row.extNumber || '').trim();
      const hasRowSerial = !!(rowSerial && /^(OP|ST|EB|P|PRB)/i.test(rowSerial));
      const isSealed = !(ctVal === 'DON!!' || hasRowSerial || ctVal === 'CHARACTER' || ctVal === 'LEADER');
      if (!isSealed && pricePids.has(pid)) {
        const priceRows = prices.filter(p => String(p.productId) === pid);
        const hasVariant = priceRows.some(p =>
          p.subTypeName === 'Normal' || p.subTypeName === 'Foil');
        if (!hasVariant) tags.push('no-variant');
      }
      const prRow = prices.find(p => String(p.productId) === pid);
      if (!prRow || !(parseFloat(prRow.marketPrice) > 0)) tags.push('no-market-price');

      // Surface in the list if it has outstanding tags OR is already completed
      if (tags.length > 0 || isCompleted) {
        issues.push({
          productId:       pid,
          name:            row.name.trim(),
          setName:         setMeta.name,
          imageUrl:        hasCustomImage ? row.customImageUrl : (row.imageUrl || row.imageURL || ''),
          originalImageUrl: row.imageUrl || row.imageURL || '',
          tags,
          completed:       isCompleted,
          hasCustomImage,
          hasManualPrice,
          manualPrice:     hasManualPrice ? (prices.find(p => String(p.productId)===pid) || null) : null
        });
      }
    }
    } catch(e) { console.warn(`[buildEditIssues] skipping set ${setMeta.groupId}: ${e.message}`); }
  }

  return issues;
}

// ══════════════════════════════════════════════════════════════════════════════
// API Routes
// ══════════════════════════════════════════════════════════════════════════════

// ── Debug probe — GET /api/probe?url=https://tcgcsv.com/... ──────────────────
app.get('/api/probe', async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith('https://tcgcsv.com/')) return res.status(400).json({ error: 'Provide a tcgcsv.com url param' });
  try {
    const txt = await fetchText(url, 10000);
    const preview = txt.trim().substring(0, 800);
    let jsonParsed = null;
    try { jsonParsed = JSON.parse(txt); } catch (_) {}
    const csvRows = parseCSV(txt);
    res.json({
      url,
      length: txt.length,
      preview,
      isJson: !!jsonParsed,
      jsonTopKeys: jsonParsed ? Object.keys(Array.isArray(jsonParsed) ? (jsonParsed[0]||{}) : jsonParsed) : null,
      csvRowCount: csvRows.length,
      csvColumns: csvRows.length ? Object.keys(csvRows[0]) : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Diagnostic: show sealed items that have a serial number ──────────────────
app.get('/api/debug/sealed-with-serial', async (req, res) => {
  try {
    const sets   = await getLocalSets();
    const samples = [];
    for (const s of sets) {
      if (samples.length >= 30) break;
      const prods = await readCSVFile(path.join(setDir(s.groupId), 'products.csv'));
      for (const row of prods) {
        if (samples.length >= 30) break;
        const ctVal = (row.extCardType || '').trim().toUpperCase();
        const serial = row.extNumber || '';
        const hasSerial = !!(serial && /^(OP|ST|EB|P|PRB)/i.test(serial));
        const isDon = ctVal === 'DON!!';
        const type = isDon ? 'don' : (hasSerial ? 'card' : 'sealed');
        // Only show items classified as sealed that look like they might be cards
        if (type === 'sealed' && (serial || row.name.match(/\b(OP|ST|EB)\d/i))) {
          // Show all ext* columns to see what data exists
          const extCols = {};
          Object.keys(row).forEach(k => { if (k.startsWith('ext')) extCols[k] = row[k]; });
          samples.push({
            productId: row.productId,
            name:      row.name,
            serial,
            ctVal,
            setName:   s.name,
            extCols,
            allKeys:   Object.keys(row),
          });
        }
      }
    }
    res.json({ count: samples.length, samples });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


app.get('/api/debug', async (req, res) => {
  try {
    const sets = await getLocalSets();
    const report = [];
    for (const s of sets.slice(0, 5)) { // first 5 sets only
      const dir = setDir(s.groupId);
      const prods  = await readCSVFile(path.join(dir, 'products.csv'));
      const prices = await readCSVFile(path.join(dir, 'prices.csv'));
      const sample = prods[0] || {};
      const cols   = Object.keys(sample);
      const extCols = cols.filter(c => c.startsWith('ext'));
      report.push({
        groupId:   s.groupId,
        name:      s.name,
        prodRows:  prods.length,
        priceRows: prices.length,
        allCols:   cols,
        extCols,
        sampleRow: sample,
      });
    }
    res.json({ totalSets: sets.length, first5: report });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


app.get('/api/status', async (req, res) => {
  try {
    const state = await getState();
    // Count set dirs cheaply without parsing every meta.json
    let setCount = 0;
    try {
      const dirs = await fsp.readdir(SETS_DIR);
      for (const d of dirs) {
        try { await fsp.access(path.join(SETS_DIR, d, 'meta.json')); setCount++; } catch {}
      }
    } catch {}
    res.json({
      sets:           setCount,
      hasData:        setCount > 0,
      lastUpdatedTxt: state.lastUpdatedTxt || '',
      lastChecked:    state.lastChecked    || 0,
      lastUpdatedAt:  state.lastUpdatedAt  || 0,
      pendingUpdateAt:state.pendingUpdateAt || 0,
      updateRunning,
      updateLog:   updateLog   || '',
      scrapeRunning,
      scrapeLog:   scrapeLog   || '',
      lastEditAt,
      imgFetchRunning,
      imgFetchLog: imgFetchLog || '',
      imgFetchDone,
      imgFetchTotal,
      imgProcessRunning,
      imgProcessLog: imgProcessLog || '',
      imgProcessDone,
      imgProcessTotal
    });
  } catch(e) {
    res.json({ sets:0, hasData:false, updateRunning, updateLog:updateLog||'', scrapeRunning, scrapeLog:scrapeLog||'', error:e.message });
  }
});

// ── Full DB ───────────────────────────────────────────────────────────────────
app.get('/api/db', async (req, res) => {
  try {
    res.json(await buildDB());
  } catch (e) {
    console.error('/api/db error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Force update ──────────────────────────────────────────────────────────────
app.post('/api/update', (req, res) => {
  if (updateRunning) return res.json({ ok: false, message: 'Already running' });
  res.json({ ok: true, message: 'Update started' });
  runUpdate();
});

// ── Set list ──────────────────────────────────────────────────────────────────
app.get('/api/sets', async (req, res) => {
  res.json(await getLocalSets());
});

// ── Edit issues list ──────────────────────────────────────────────────────────
app.get('/api/edits/issues', async (req, res) => {
  try { res.json(await buildEditIssues()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Image edit ────────────────────────────────────────────────────────────────
app.post('/api/edits/image', async (req, res) => {
  const { productId, imageUrl } = req.body;
  if (!productId || !imageUrl) return res.status(400).json({ error: 'Missing fields' });
  const ok = await findAndUpdateProductRow(productId, { customImageUrl: imageUrl });
  if (ok) checkAutoComplete(productId).catch(()=>{});
  res.json({ ok });
});

app.delete('/api/edits/image/:pid', async (req, res) => {
  await findAndUpdateProductRow(req.params.pid, { customImageUrl: '' });
  res.json({ ok: true });
});

// ── Manual price entry ────────────────────────────────────────────────────────
app.post('/api/edits/price', async (req, res) => {
  const { productId, subTypeName, lowPrice, midPrice, highPrice, marketPrice } = req.body;
  if (!productId) return res.status(400).json({ error: 'Missing productId' });
  const toNum = v => (v !== '' && v != null) ? (parseFloat(v) || null) : null;
  const priceEntry = {
    productId:      parseInt(productId),
    subTypeName:    subTypeName || '',
    lowPrice:       toNum(lowPrice),
    midPrice:       toNum(midPrice),
    highPrice:      toNum(highPrice),
    marketPrice:    toNum(marketPrice),
    directLowPrice: null
  };

  // Write directly into the set's prices.csv
  try {
    const groupId = await findProductGroupId(productId);
    if (groupId) {
      const pricesFile = path.join(setDir(groupId), 'prices.csv');
      let existPrices = await readCSVFile(pricesFile);
      const pidStr  = String(productId);
      const priceKey = p => `${String(p.productId)}__${p.subTypeName || ''}`;
      const k = `${pidStr}__${subTypeName || ''}`;
      const flatRow = flattenPrice(priceEntry);

      // If saving a typed variant (Normal/Foil), remove untyped rows for this product
      // — those are scraped rows where subTypeName was not yet known
      if (subTypeName === 'Normal' || subTypeName === 'Foil') {
        existPrices = existPrices.filter(p =>
          !(String(p.productId) === pidStr && !p.subTypeName));
      }

      const idx = existPrices.findIndex(p => priceKey(p) === k);
      if (idx >= 0) existPrices[idx] = { ...existPrices[idx], ...flatRow };
      else existPrices.push(flatRow);

      await writeCSVFile(pricesFile, existPrices);
      lastEditAt = Date.now();
      checkAutoComplete(productId).catch(()=>{});
    }
  } catch(e) {
    console.warn('[edits/price] CSV write failed:', e.message);
  }

  dbCache = null;
  res.json({ ok: true });
});

app.delete('/api/edits/price/:pid', async (req, res) => {
  try {
    const pid = req.params.pid;
    const groupId = await findProductGroupId(pid);
    if (groupId) {
      const pricesFile = path.join(setDir(groupId), 'prices.csv');
      const rows = await readCSVFile(pricesFile);
      const filtered = rows.filter(r => String(r.productId) !== String(pid));
      await writeCSVFile(pricesFile, filtered);
      dbCache = null;
      lastEditAt = Date.now();
    }
  } catch(e) { console.warn('[delete price]', e.message); }
  res.json({ ok: true });
});

// ── Completed status ──────────────────────────────────────────────────────────
app.post('/api/edits/complete', async (req, res) => {
  const { productId } = req.body;
  if (!productId) return res.status(400).json({ error: 'Missing productId' });
  await findAndUpdateProductRow(productId, { editCompleted: '1' });
  res.json({ ok: true });
});

app.post('/api/edits/uncomplete', async (req, res) => {
  const { productId } = req.body;
  if (!productId) return res.status(400).json({ error: 'Missing productId' });
  await findAndUpdateProductRow(productId, { editCompleted: '' });
  res.json({ ok: true });
});

// ── Image proxy — fetches remote images server-side to bypass hotlink protection ─
app.get('/api/img-proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing url');
  // Only proxy known card image domains
  const allowed = ['en.onepiece-cardgame.com', 'tcgplayer-cdn.tcgplayer.com',
                   'product-images.tcgplayer.com', 'cdn.tcgplayer.com'];
  let host;
  try { host = new URL(url).hostname; } catch { return res.status(400).send('Bad url'); }
  if (!allowed.some(d => host === d || host.endsWith('.' + d)))
    return res.status(403).send('Domain not allowed');

  try {
    await new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? require('https') : require('http');
      const reqOpts = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Referer':    'https://en.onepiece-cardgame.com/',
          'Accept':     'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        }
      };
      const remote = mod.get(url, reqOpts, (remResp) => {
        if (remResp.statusCode === 301 || remResp.statusCode === 302) {
          // Follow one redirect
          const loc = remResp.headers.location;
          remResp.resume();
          if (!loc) { res.status(404).send('Redirect with no location'); return resolve(); }
          const mod2 = loc.startsWith('https') ? require('https') : require('http');
          mod2.get(loc, reqOpts, (r2) => {
            res.setHeader('Content-Type', r2.headers['content-type'] || 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            r2.pipe(res);
            r2.on('end', resolve);
            r2.on('error', reject);
          }).on('error', reject);
          return;
        }
        if (remResp.statusCode !== 200) {
          res.status(remResp.statusCode).send('Remote error');
          return resolve();
        }
        res.setHeader('Content-Type', remResp.headers['content-type'] || 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        remResp.pipe(res);
        remResp.on('end', resolve);
        remResp.on('error', reject);
      });
      remote.on('error', reject);
      remote.setTimeout(10000, () => { remote.destroy(); reject(new Error('timeout')); });
    });
  } catch(e) {
    if (!res.headersSent) res.status(502).send('Proxy error: ' + e.message);
  }
});



// Detect sets whose products.csv was saved with [object Object] (old bad format)
// and delete them so they get cleanly re-downloaded.
async function purgeCorruptSets() {
  const sets = await getLocalSets();
  let wiped = 0;
  for (const s of sets) {
    const prodFile = path.join(setDir(s.groupId), 'products.csv');
    try {
      // Read only first 2KB — enough to check the header row and one data row
      const fd  = await fsp.open(prodFile, 'r');
      const buf = Buffer.alloc(2048);
      const { bytesRead } = await fd.read(buf, 0, 2048, 0);
      await fd.close();
      const sample = buf.slice(0, bytesRead).toString('utf8');
      const headerLine = sample.split('\n')[0] || '';
      const cols = headerLine.split(',');
      const hasExtCols    = cols.some(c => c.trim().startsWith('ext'));
      const hasObjectJunk = sample.includes('[object Object]');
      if (!hasExtCols || hasObjectJunk) {
        console.log(`[init] Wiping corrupt set ${s.groupId} (${s.name}) — hasExt:${hasExtCols} objJunk:${hasObjectJunk}`);
        await fsp.rm(setDir(s.groupId), { recursive: true, force: true });
        wiped++;
      }
    } catch { /* file missing or unreadable — will be re-downloaded */ }
  }
  return wiped;
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}
function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; }
}
function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// POST /api/auth/signup  { email, firstName, lastName, username, password }
app.post('/api/auth/signup', (req, res) => {
  const { email, firstName, lastName, username, password } = req.body || {};
  if (!email || !firstName || !lastName || !username || !password)
    return res.status(400).json({ error: 'All fields required' });
  if (username.length < 3)
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const users = readUsers();
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase()))
    return res.status(409).json({ error: 'Email already registered' });
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase()))
    return res.status(409).json({ error: 'Username already taken' });
  const newUser = { email, firstName, lastName, username, passwordHash: djb2(password) };
  users.push(newUser);
  writeUsers(users);
  res.json({ username, email, firstName, lastName });
});

// POST /api/auth/signin  { identifier, password }  (identifier = email or username)
app.post('/api/auth/signin', (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password)
    return res.status(400).json({ error: 'Missing credentials' });
  const users = readUsers();
  const user = users.find(u =>
    (u.email.toLowerCase() === identifier.toLowerCase() ||
     u.username.toLowerCase() === identifier.toLowerCase()) &&
    u.passwordHash === djb2(password)
  );
  if (!user) return res.status(401).json({ error: 'Incorrect email/username or password' });
  res.json({ username: user.username, email: user.email, firstName: user.firstName, lastName: user.lastName });
});

app.listen(PORT, () => {
  console.log(`\n  TCG Marketplace  →  http://localhost:${PORT}`);
  console.log(`  Serving:          ${path.join(__dirname, 'public')}`);
  console.log(`  Data:             ${DATA_DIR}\n`);

  // Run async startup tasks without blocking the server from accepting requests
  (async () => {
    try {
      // Remove legacy edits.json if present — edits now live in the CSV files directly
      try { await fsp.unlink(path.join(DATA_DIR, 'edits.json')); console.log('[init] Removed legacy edits.json'); } catch {}
      const wiped = await purgeCorruptSets();
      const sets  = await getLocalSets();
      if (!sets.length || wiped > 0) {
        if (wiped > 0) console.log(`[init] Wiped ${wiped} corrupt set(s) — re-downloading…`);
        else            console.log('[init] No local data — running initial download…');
        runUpdate(); // processProductImages is triggered inside runUpdate on completion
      } else {
        console.log(`[init] ${sets.length} sets ready`);
        // Process any TCGPlayer images that haven't been cached yet
        setTimeout(() => processProductImages(), 3000);
      }
    } catch(e) {
      console.error('[init] Startup error:', e.message);
    }
  })();

  // Check last-updated.txt every 2 minutes
  setInterval(checkForUpdates, 2 * 60 * 1000);
  setTimeout(checkForUpdates, 10_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// Price Scraper (server-side)
// ══════════════════════════════════════════════════════════════════════════════
let scrapeRunning = false;
let scrapeLog     = '';

async function fetchPricepoints(pid) {
  try {
    const txt = await fetchText(`https://mpapi.tcgplayer.com/v2/product/${pid}/pricepoints`, 12000);
    const data = JSON.parse(txt);
    const arr = Array.isArray(data) ? data : (data.result || data.results || []);
    return arr.length ? arr : null;
  } catch { return null; }
}

async function scrapeMissingPrices() {
  if (scrapeRunning) return;
  scrapeRunning = true;
  scrapeLog = 'Building missing-price list…';

  try {
    const sets = await getLocalSets();
    const missing = []; // [{pid, groupId}]

    for (const s of sets) {
      const dir    = setDir(s.groupId);
      const prods  = await readCSVFile(path.join(dir, 'products.csv'));
      const prices = await readCSVFile(path.join(dir, 'prices.csv'));
      const pricedPids = new Set(prices.map(p => String(p.productId)));
      for (const p of prods) {
        if (p.productId && !pricedPids.has(String(p.productId)))
          missing.push({ pid: String(p.productId), groupId: s.groupId });
      }
    }

    if (!missing.length) {
      scrapeLog = 'All products already have prices';
      console.log('[scrape] Nothing to scrape');
      scrapeRunning = false;
      return;
    }

    console.log(`[scrape] ${missing.length} products missing prices`);
    scrapeLog = `Scraping 0/${missing.length}…`;

    // Fetch prices concurrently but write each set's prices.csv sequentially
    // to avoid concurrent reads/writes to the same file (race condition)
    const FETCH_BATCH = 12;
    let done = 0, found = 0;

    for (let i = 0; i < missing.length; i += FETCH_BATCH) {
      const batch = missing.slice(i, i + FETCH_BATCH);

      // Concurrent HTTP fetches — no file I/O, safe to parallelise
      const fetched = await Promise.all(
        batch.map(({ pid, groupId }) =>
          fetchPricepoints(pid).then(pts => ({ pid, groupId, pts }))
        )
      );

      // Group results by set so we write each prices.csv exactly once
      const byGroup = {};
      for (const { pid, groupId, pts } of fetched) {
        done++;
        if (!pts) continue;
        if (!byGroup[groupId]) byGroup[groupId] = [];
        byGroup[groupId].push({ pid, pts });
      }

      // Sequential per-set writes — no concurrent access to the same file
      for (const [groupId, items] of Object.entries(byGroup)) {
        const pricesFile = path.join(setDir(groupId), 'prices.csv');
        const existPrices = await readCSVFile(pricesFile);
        const priceKey = p => `${p.productId}__${p.subTypeName || ''}`;
        const priceMap = new Map(existPrices.map(p => [priceKey(p), p]));

        for (const { pid, pts } of items) {
          // If any returned price point has a real subTypeName, remove untyped rows first
          const hasTyped = pts.some(pt => pt.subTypeName === 'Normal' || pt.subTypeName === 'Foil');
          if (hasTyped) {
            const before = existPrices.length;
            existPrices = existPrices.filter(p =>
              !(String(p.productId) === String(pid) && !p.subTypeName));
            if (existPrices.length < before) {
              // Rebuild priceMap after filtering
              priceMap.clear();
              existPrices.forEach(p => priceMap.set(priceKey(p), p));
            }
          }
          for (const pt of pts) {
            const row = flattenPrice({
              productId: parseInt(pid), subTypeName: pt.subTypeName || '',
              lowPrice: pt.lowPrice ?? null, midPrice: pt.midPrice ?? null,
              highPrice: pt.highPrice ?? null, marketPrice: pt.marketPrice ?? null,
              directLowPrice: pt.directLowPrice ?? null,
            });
            const k = priceKey(row);
            if (priceMap.has(k)) {
              const ex = priceMap.get(k);
              for (const f of ['lowPrice','midPrice','highPrice','marketPrice','directLowPrice'])
                if (row[f] !== '') ex[f] = row[f];
            } else {
              existPrices.push(row);
              priceMap.set(k, row);
            }
            found++;
          }
        }
        await writeCSVFile(pricesFile, existPrices);
      }

      scrapeLog = `Scraping ${done}/${missing.length} (${found} prices found)`;
      if (i + FETCH_BATCH < missing.length) await new Promise(r => setTimeout(r, 100));
    }

    console.log(`[scrape] Done — ${found} prices recovered for ${missing.length} products`);
    scrapeLog = `Scrape complete: ${found} prices recovered`;
    dbCache = null;
  } catch(e) {
    scrapeLog = 'Scrape error: ' + e.message;
    console.error('[scrape] Error:', e.message);
  }

  scrapeRunning = false;
  setTimeout(() => { if (!scrapeRunning) scrapeLog = ''; }, 60000);
}

// ── Find which set a product belongs to ──────────────────────────────────────
async function findProductGroupId(productId) {
  const pidStr = String(productId);
  const sets   = await getLocalSets();
  for (const s of sets) {
    const prods = await readCSVFile(path.join(setDir(s.groupId), 'products.csv'));
    if (prods.some(p => String(p.productId) === pidStr)) return s.groupId;
  }
  return null;
}


// ── Update a product row directly in its set's products.csv ──────────────────
async function findAndUpdateProductRow(productId, updates) {
  const pidStr = String(productId);
  const sets   = await getLocalSets();
  for (const s of sets) {
    const prodFile = path.join(setDir(s.groupId), 'products.csv');
    const prods    = await readCSVFile(prodFile);
    const idx      = prods.findIndex(p => String(p.productId) === pidStr);
    if (idx >= 0) {
      Object.assign(prods[idx], updates);
      await writeCSVFile(prodFile, prods);
      dbCache = null;
      lastEditAt = Date.now();
      return true;
    }
  }
  return false;
}

// ══════════════════════════════════════════════════════════════════════════════
// New API Routes
// ══════════════════════════════════════════════════════════════════════════════

// ── All items for Edit CSV tab (paginated, filtered, sorted) ──────────────────
app.get('/api/items', async (req, res) => {
  try {
    const q        = (req.query.q    || '').toLowerCase().trim();
    const typeF    = req.query.type  || 'all';
    const sort     = req.query.sort  || 'name';
    const tagF     = req.query.tag   || '';
    const showCompleted = tagF === 'completed';
    const onlyIssues    = !showCompleted && tagF !== '' && tagF !== 'all';
    const page     = parseInt(req.query.page) || 0;
    const PAGE_SIZE = 60;

    const sets  = await getLocalSets();
    const all   = [];

    for (const s of sets) {
      const dir    = setDir(s.groupId);
      const prods  = await readCSVFile(path.join(dir, 'products.csv'));
      const prices = await readCSVFile(path.join(dir, 'prices.csv'));
      const pricePids = new Set(prices.map(p => String(p.productId)));

      for (const row of prods) {
        if (!row.name || !row.name.trim()) continue;
        try {
          const pid = String(parseInt(row.productId) || 0);
          const ctVal = (row.extCardType || '').trim().toUpperCase();
          const rowSerial = (row.extNumber || '').trim();
          const hasSerial = !!(rowSerial && /^(OP|ST|EB|P|PRB)/i.test(rowSerial));
          const isCardType = ctVal === 'CHARACTER' || ctVal === 'LEADER';
          const itemType = ctVal === 'DON!!' ? 'don' : (hasSerial || isCardType ? 'cards' : 'sealed');

          const priceRow  = prices.find(p => String(p.productId) === pid);
          const priceRows = prices.filter(p => String(p.productId) === pid);
          const mp = priceRow ? (parseFloat(priceRow.marketPrice) || 0) : 0;

          const hasManualPrice = pricePids.has(pid);
          const hasCustomImage = !!(row.customImageUrl);
          const isCompleted    = row.editCompleted === '1';

          const rawImg = row.imageUrl || row.imageURL || '';
          const tags   = [];
          if (!pricePids.has(pid) && !hasManualPrice) tags.push('no-price');
          // image-not-updated: no image saved (processed TCGPlayer images write to customImageUrl)
          if (!hasCustomImage) tags.push('image-not-updated');
          // Flag if price rows exist but none have Normal or Foil subTypeName
          // (only applies to cards/don — sealed products don't have variants)
          if (itemType !== 'sealed' && priceRows.length > 0) {
            const hasVariant = priceRows.some(p =>
              p.subTypeName === 'Normal' || p.subTypeName === 'Foil');
            if (!hasVariant) tags.push('no-variant');
          }
          if (mp <= 0) tags.push('no-market-price');

          const firstPriceRow = priceRows[0] || {};
          all.push({
            productId: pid,
            name:      row.name.trim(),
            setName:   s.name,
            type:      itemType,
            number:    row.extNumber || '',
            url:       row.url || '',
            marketPrice: mp,
            lowPrice:    parseFloat(firstPriceRow.lowPrice)  || 0,
            midPrice:    parseFloat(firstPriceRow.midPrice)  || 0,
            highPrice:   parseFloat(firstPriceRow.highPrice) || 0,
            subTypeName: firstPriceRow.subTypeName || '',
            imageUrl:  hasCustomImage ? row.customImageUrl : rawImg,
            originalImageUrl: rawImg,
            tags, completed: isCompleted, hasCustomImage, hasManualPrice,
            manualPrice: hasManualPrice ? (prices.find(p => String(p.productId)===pid) || null) : null,
          });
        } catch {}
      }
    }

    // Filter
    let items = all;
    if (q) items = items.filter(i =>
      i.name.toLowerCase().includes(q) ||
      i.setName.toLowerCase().includes(q) ||
      i.number.toLowerCase().includes(q));
    if (typeF !== 'all') items = items.filter(i => i.type === typeF);
    // Tag-specific filter
    if (showCompleted)       items = items.filter(i => i.completed);
    else if (tagF && tagF !== 'all') items = items.filter(i => (i.tags||[]).includes(tagF));
    else if (onlyIssues)     items = items.filter(i => i.tags.length > 0);
    // Exclude completed items unless explicitly requested
    if (!showCompleted)      items = items.filter(i => !i.completed);

    // Sort
    if      (sort === 'price-high') items.sort((a,b) => b.marketPrice - a.marketPrice);
    else if (sort === 'price-low')  items.sort((a,b) => a.marketPrice - b.marketPrice);
    else                            items.sort((a,b) => a.name.localeCompare(b.name));

    const total = items.length;
    const page_items = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    res.json({ items: page_items, total, page, pageSize: PAGE_SIZE });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Trigger / status for price scraper ───────────────────────────────────────
app.post('/api/scrape', (req, res) => {
  if (scrapeRunning) return res.json({ ok:false, message:'Already running' });
  res.json({ ok:true, message:'Scraping started' });
  scrapeMissingPrices();
});


// ══════════════════════════════════════════════════════════════════════════════
// Image Link Cache
// ══════════════════════════════════════════════════════════════════════════════
const CARD_IMAGES_FILE = path.join(DATA_DIR, 'card-images.json');
let imgFetchRunning = false, imgFetchLog = '', imgFetchDone = 0, imgFetchTotal = 0;

function opImgUrl(serial, suffix = '') {
  return `https://en.onepiece-cardgame.com/images/cardlist/card/${serial}${suffix}.png`;
}

async function checkOPImage(url) {
  return new Promise(resolve => {
    const req = https.request(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer':    'https://en.onepiece-cardgame.com/',
        'Accept':     'image/webp,image/apng,image/*,*/*;q=0.8',
      }
    }, resp => { resolve(resp.statusCode === 200); resp.resume(); });
    req.on('error', () => resolve(false));
    req.setTimeout(8000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function fetchCardImages(refreshOnly = true) {
  if (imgFetchRunning) return;
  imgFetchRunning = true;
  imgFetchLog = 'Building serial list…';

  try {
    const cache = await readJSON(CARD_IMAGES_FILE, {});
    const sets   = await getLocalSets();
    const serials = new Set();

    for (const s of sets) {
      const prods = await readCSVFile(path.join(setDir(s.groupId), 'products.csv'));
      for (const row of prods) {
        const num = (row.extNumber || '').trim().toUpperCase();
        if (num && /^(OP|ST|EB|P|PRB)/i.test(num)) serials.add(num);
      }
    }

    const toCheck = refreshOnly
      ? [...serials].filter(s => !cache[s])
      : [...serials];

    imgFetchTotal = toCheck.length;
    imgFetchDone  = 0;
    console.log(`[imgFetch] ${toCheck.length} serials to check (refreshOnly=${refreshOnly})`);

    for (let i = 0; i < toCheck.length; i++) {
      const serial = toCheck[i];
      const urls   = [];

      // 1. Base (FIRST)
      const baseUrl = opImgUrl(serial);
      if (await checkOPImage(baseUrl)) {
        urls.push(baseUrl);

        // 2. _p1, _p2, … until miss
        for (let p = 1; p <= 15; p++) {
          const u = opImgUrl(serial, `_p${p}`);
          if (await checkOPImage(u)) urls.push(u); else break;
          await new Promise(r => setTimeout(r, 60));
        }

        // 3. _r1, _r2, … until miss
        for (let r = 1; r <= 8; r++) {
          const u = opImgUrl(serial, `_r${r}`);
          if (await checkOPImage(u)) urls.push(u); else break;
          await new Promise(r => setTimeout(r, 60));
        }
      }

      if (urls.length) cache[serial] = urls;
      imgFetchDone++;
      imgFetchLog = `Images: ${imgFetchDone}/${imgFetchTotal} checked (${Object.keys(cache).length} serials with images)`;

      await new Promise(r => setTimeout(r, 80));
      if (i % 50 === 49) await writeJSON(CARD_IMAGES_FILE, cache);
    }

    await writeJSON(CARD_IMAGES_FILE, cache);
    imgFetchLog = `Done — ${Object.keys(cache).length} serials cached`;
    console.log('[imgFetch]', imgFetchLog);
  } catch(e) {
    imgFetchLog = 'Error: ' + e.message;
    console.error('[imgFetch]', e.message);
  }
  imgFetchRunning = false;
}

app.get('/api/card-images', async (req, res) => {
  const serial = req.query.serial;
  const cache  = await readJSON(CARD_IMAGES_FILE, {});
  if (serial) return res.json({ urls: cache[serial.toUpperCase()] || [] });
  res.json(cache);
});

// Returns { imageUrl: productId } for every product that has a customImageUrl set
app.get('/api/image-usage', async (req, res) => {
  try {
    const sets  = await getLocalSets();
    const usage = {};   // url → productId (first seen wins)
    for (const s of sets) {
      const prods = await readCSVFile(path.join(setDir(s.groupId), 'products.csv'));
      for (const row of prods) {
        const url = (row.customImageUrl || '').trim();
        if (url && !usage[url]) usage[url] = String(row.productId);
      }
    }
    res.json(usage);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/images/fetch', (req, res) => {
  const refresh = req.body && req.body.refresh === true;
  if (imgFetchRunning) return res.json({ ok: false, message: 'Already running' });
  res.json({ ok: true, message: refresh ? 'Checking new serials…' : 'Full fetch started' });
  fetchCardImages(refresh);
});

app.post('/api/images/process-tcg', (req, res) => {
  if (imgProcessRunning) return res.json({ ok: false, message: 'Already running' });
  res.json({ ok: true, message: 'TCGPlayer image processing started' });
  processProductImages();
});

// ══════════════════════════════════════════════════════════════════════════════
// Auto-complete + single-item helpers
// ══════════════════════════════════════════════════════════════════════════════

// Check if a product now has zero errors; if so mark editCompleted in products.csv
async function checkAutoComplete(productId) {
  const pidStr  = String(productId);
  const sets    = await getLocalSets();
  for (const s of sets) {
    const dir        = setDir(s.groupId);
    const prods      = await readCSVFile(path.join(dir, 'products.csv'));
    const row        = prods.find(p => String(p.productId) === pidStr);
    if (!row) continue;

    const prices     = await readCSVFile(path.join(dir, 'prices.csv'));
    const priceRows  = prices.filter(p => String(p.productId) === pidStr);
    const ctVal      = (row.extCardType || '').trim().toUpperCase();
    const rowSer     = (row.extNumber || '').trim();
    const hasRowSer  = !!(rowSer && /^(OP|ST|EB|P|PRB)/i.test(rowSer));
    const isSealed   = !(ctVal === 'DON!!' || hasRowSer || ctVal === 'CHARACTER' || ctVal === 'LEADER');
    const rawImg     = row.imageUrl || row.imageURL || '';

    const hasPrice   = priceRows.length > 0;
    const hasVariant = isSealed || priceRows.some(p => p.subTypeName === 'Normal' || p.subTypeName === 'Foil');
    const imageOk    = !!(row.customImageUrl) || rawImg.includes('onepiece-cardgame');

    if (hasPrice && hasVariant && imageOk) {
      // No more errors — auto-complete
      const idx = prods.findIndex(p => String(p.productId) === pidStr);
      if (idx >= 0 && prods[idx].editCompleted !== '1') {
        prods[idx].editCompleted = '1';
        await writeCSVFile(path.join(dir, 'products.csv'), prods);
        dbCache = null;
        lastEditAt = Date.now();
        console.log(`[autoComplete] ${pidStr} (${row.name})`);
      }
    }
    return;
  }
}

// Return fresh data for one product (for no-reload UI updates)
app.get('/api/item/:productId', async (req, res) => {
  try {
    const pidStr = String(parseInt(req.params.productId) || 0);
    const sets   = await getLocalSets();
    for (const s of sets) {
      const dir    = setDir(s.groupId);
      const prods  = await readCSVFile(path.join(dir, 'products.csv'));
      const row    = prods.find(p => String(p.productId) === pidStr);
      if (!row) continue;
      const prices    = await readCSVFile(path.join(dir, 'prices.csv'));
      const pricePids = new Set(prices.map(p => String(p.productId)));
      const priceRow  = prices.find(p => String(p.productId) === pidStr);
      const priceRows = prices.filter(p => String(p.productId) === pidStr);
      const mp        = priceRow ? (parseFloat(priceRow.marketPrice) || 0) : 0;
      const ctVal     = (row.extCardType || '').trim().toUpperCase();
      const rowSer2   = (row.extNumber || '').trim();
      const hasSer2   = !!(rowSer2 && /^(OP|ST|EB|P|PRB)/i.test(rowSer2));
      const isCard2   = hasSer2 || ctVal === 'CHARACTER' || ctVal === 'LEADER';
      const itemType  = ctVal === 'DON!!' ? 'don' : (isCard2 ? 'cards' : 'sealed');
      const hasCustomImage = !!(row.customImageUrl);
      const rawImg    = row.imageUrl || row.imageURL || '';
      const hasManualPrice = pricePids.has(pidStr);
      const isCompleted = row.editCompleted === '1';
      const tags = [];
      if (!pricePids.has(pidStr)) tags.push('no-price');
      if (!hasCustomImage && !rawImg.includes('onepiece-cardgame')) tags.push('image-not-updated');
      if (itemType !== 'sealed' && priceRows.length > 0) {
        const hasVariant = priceRows.some(p => p.subTypeName === 'Normal' || p.subTypeName === 'Foil');
        if (!hasVariant) tags.push('no-variant');
      }
      if (mp <= 0) tags.push('no-market-price');
      const firstPriceRow = priceRows[0] || {};
      return res.json({
        productId: pidStr, name: row.name.trim(), setName: s.name,
        type: itemType, number: row.extNumber || '', url: row.url || '',
        marketPrice: mp,
        lowPrice:    parseFloat(firstPriceRow.lowPrice)    || 0,
        midPrice:    parseFloat(firstPriceRow.midPrice)    || 0,
        highPrice:   parseFloat(firstPriceRow.highPrice)   || 0,
        subTypeName: firstPriceRow.subTypeName || '',
        imageUrl: hasCustomImage ? row.customImageUrl : rawImg,
        originalImageUrl: rawImg,
        tags, completed: isCompleted, hasCustomImage, hasManualPrice,
        manualPrice: hasManualPrice ? firstPriceRow : null,
      });
    }
    res.status(404).json({ error: 'Not found' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
