#!/usr/bin/env node
/**
 * ============================================================
 *  Monero Nonce Analyzer
 *
 *  1. Pobiera nonce z ostatnich N bloków (domyślnie 500)
 *  2. Analizuje rozkład statystyczny
 *  3. Wskazuje przedziały o największej gęstości
 *  4. Eksportuje funkcję suggestNonce() do użycia w solo-miner.js
 *
 *  UŻYCIE:
 *    node nonce-analyzer.js              ← analiza + zapis modelu
 *    node nonce-analyzer.js --blocks 200 ← mniej bloków
 *    node nonce-analyzer.js --model nonce-model.json
 *    node nonce-analyzer.js --help
 *
 *  IMPORT W SOLO-MINER:
 *    const { suggestNonce, loadModel } = require('./nonce-analyzer');
 * ============================================================
 */

'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ─── Kolory ANSI ─────────────────────────────────────────────────────────────
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m',
    orange: '\x1b[38;5;208m', green: '\x1b[32m', red: '\x1b[31m',
    cyan: '\x1b[36m', yellow: '\x1b[33m', gray: '\x1b[90m',
    white: '\x1b[97m', magenta: '\x1b[35m',
};
const c = (col, s) => `${col}${s}${C.reset}`;

const opts = parseArgs();

// ─── Stałe ───────────────────────────────────────────────────────────────────
const MAX_NONCE = 4294967295;    // 2^32 - 1
const MODEL_FILE = path.join(__dirname, opts.model);

// API publiczne explorera – zwraca nonce w bloku
// GET https://localmonero.co/blocks/api/get_block_header/{height}
// Odpowiedź: { block_header: { nonce: 1234, height: X, difficulty: Y, ... } }
const EXPLORER_API = 'https://localmonero.co/blocks/api';

// ─── Prosty fetch GET ─────────────────────────────────────────────────────────
function fetchGet(url, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.get(url, { timeout: timeoutMs }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} dla ${url}`));
            }
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

// ─── Pobierz aktualną wysokość blokchainu ─────────────────────────────────────
async function getCurrentHeight() {
    const data = await fetchGet(`${EXPLORER_API}/get_stats`);
    return data.height;
}

// ─── Pobierz nonce jednego bloku (z retry) ────────────────────────────────────
async function getBlockNonce(height, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const data = await fetchGet(`${EXPLORER_API}/get_block_header/${height}`);
            if (data && data.block_header && data.block_header.nonce !== undefined) {
                return {
                    height,
                    nonce: data.block_header.nonce,
                    difficulty: data.block_header.difficulty,
                    timestamp: data.block_header.timestamp,
                };
            }
            throw new Error('brak pola nonce w odpowiedzi');
        } catch (e) {
            if (i === retries - 1) throw e;
            await sleep(500 * (i + 1)); // backoff
        }
    }
}

// ─── Pobierz N bloków równolegle (z ograniczeniem concurrency) ────────────────
async function fetchBlocks(topHeight, count, concurrency = 10) {
    const results = [];
    let done = 0;
    let failed = 0;

    // Buduj listę wysokości do pobrania
    const heights = [];
    for (let h = topHeight; h > topHeight - count && h > 0; h--) {
        heights.push(h);
    }

    // Przetwarzaj partiami
    for (let i = 0; i < heights.length; i += concurrency) {
        const batch = heights.slice(i, i + concurrency);
        const settled = await Promise.allSettled(batch.map(h => getBlockNonce(h)));

        settled.forEach((result, idx) => {
            if (result.status === 'fulfilled') {
                results.push(result.value);
                done++;
            } else {
                failed++;
            }
        });

        // Postęp
        const pct = Math.round((i + batch.length) / heights.length * 100);
        const bar = drawBar(i + batch.length, heights.length, 30);
        process.stdout.write(
            `\r  ${bar} ${c(C.cyan, pct + '%')} ` +
            `pobrано: ${c(C.green, done)} ` +
            `błędy: ${failed > 0 ? c(C.red, failed) : c(C.gray, '0')}   `
        );

        // Małe opóźnienie żeby nie przeciążyć API
        if (i + concurrency < heights.length) await sleep(200);
    }

    console.log(); // newline po pasku
    return results;
}

// ─── ANALIZA STATYSTYCZNA ─────────────────────────────────────────────────────
function analyzeNonces(blocks) {
    const nonces = blocks.map(b => b.nonce).sort((a, b) => a - b);
    const n = nonces.length;

    if (n === 0) throw new Error('Brak danych do analizy');

    // Podstawowe statystyki
    const min = nonces[0];
    const max = nonces[n - 1];
    const mean = nonces.reduce((s, v) => s + v, 0) / n;
    const median = n % 2 === 0
        ? (nonces[n / 2 - 1] + nonces[n / 2]) / 2
        : nonces[Math.floor(n / 2)];

    // Wariancja i odchylenie standardowe
    const variance = nonces.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / n;
    const stddev = Math.sqrt(variance);

    // Percentyle
    const pct = (p) => nonces[Math.floor(p * (n - 1))];
    const p10 = pct(0.10);
    const p25 = pct(0.25);
    const p75 = pct(0.75);
    const p90 = pct(0.90);

    // ── Histogram – podział na 16 przedziałów ─────────────────────────────────
    const BINS = 16;
    const binSize = MAX_NONCE / BINS;
    const hist = new Array(BINS).fill(0);
    nonces.forEach(v => {
        const idx = Math.min(Math.floor(v / binSize), BINS - 1);
        hist[idx]++;
    });

    // Znajdź przedziały z największą gęstością (top 3 biny)
    const histWithIdx = hist.map((count, i) => ({ bin: i, count }))
        .sort((a, b) => b.count - a.count);
    const topBins = histWithIdx.slice(0, 3);

    // ── Wykryj skupiska (klastry) metodą sliding window ───────────────────────
    const WINDOW = Math.floor(MAX_NONCE / 32); // okno ~134M
    const clusters = findClusters(nonces, WINDOW, 5);

    // ── Chi-kwadrat test jednorodności ────────────────────────────────────────
    const expected = n / BINS;
    const chiSquare = hist.reduce((s, obs) => s + Math.pow(obs - expected, 2) / expected, 0);
    const isUniform = chiSquare < 24.996; // df=15, α=0.05

    return {
        count: n,
        min, max, mean: Math.round(mean), median: Math.round(median),
        stddev: Math.round(stddev),
        p10: Math.round(p10),
        p25: Math.round(p25),
        p75: Math.round(p75),
        p90: Math.round(p90),
        histogram: hist,
        topBins,
        clusters,
        chiSquare: Math.round(chiSquare * 100) / 100,
        isUniform,
        coverage: (max - min) / MAX_NONCE,
        // Przedziały zalecane do szukania nonce
        hotRanges: buildHotRanges(topBins, binSize, clusters),
    };
}

// ─── Znajdź skupiska w posortowanych danych ───────────────────────────────────
function findClusters(sortedNonces, windowSize, minCount) {
    const clusters = [];
    let i = 0;

    while (i < sortedNonces.length) {
        const start = sortedNonces[i];
        const end = start + windowSize;
        let j = i;

        while (j < sortedNonces.length && sortedNonces[j] <= end) j++;
        const count = j - i;

        if (count >= minCount) {
            const vals = sortedNonces.slice(i, j);
            clusters.push({
                lo: start,
                hi: end,
                count,
                density: count / (windowSize / MAX_NONCE * 100), // względna gęstość
                center: Math.round(vals.reduce((s, v) => s + v, 0) / count),
            });
            i = j; // przesuń za klaster
        } else {
            i++;
        }
    }

    return clusters
        .sort((a, b) => b.count - a.count)
        .slice(0, 5); // top 5 klastrów
}

// ─── Zbuduj listę "gorących" przedziałów do szukania ─────────────────────────
function buildHotRanges(topBins, binSize, clusters) {
    const ranges = [];

    // Z histogramu – top 3 biny
    topBins.forEach(({ bin, count }) => {
        ranges.push({
            source: 'histogram',
            lo: Math.floor(bin * binSize),
            hi: Math.floor((bin + 1) * binSize),
            score: count,
        });
    });

    // Z klastrów
    clusters.slice(0, 2).forEach(cl => {
        ranges.push({
            source: 'cluster',
            lo: cl.lo,
            hi: Math.min(cl.hi, MAX_NONCE),
            score: cl.count * 2, // klastry ważniejsze
        });
    });

    // Usuń duplikaty i posortuj po score
    return ranges.sort((a, b) => b.score - a.score);
}

const generated = [];

// ─── KLUCZOWA FUNKCJA: suggestNonce ──────────────────────────────────────────
/**
 * Zwraca sugerowaną wartość startową nonce na podstawie modelu historycznego.
 *
 * Strategia:
 *  - 60% szans: losuj nonce z "gorącego" przedziału (duża gęstość historyczna)
 *  - 30% szans: losuj z całego zakresu 32-bit (eksploracja)
 *  - 10% szans: zacznij od 0 (standardowa iteracja)
 *
 * WAŻNE: Nonce w Monero jest losowy – ta funkcja NIE zwiększa matematycznie
 * szansy na znalezienie bloku. Celem jest demonstracja analizy danych.
 * Prawdziwy miner powinien iterować sekwencyjnie od 0 lub losowo.
 *
 * @param {Object} model  - model zwrócony przez analyzeNonces() lub loadModel()
 * @returns {number}      - sugerowany nonce startowy (0 – 4294967295)
 */
function suggestNonce(model) {
    if (!model || !model.hotRanges || model.hotRanges.length === 0) {
        // Brak modelu → losowy nonce
        return Math.floor(Math.random() * MAX_NONCE);
    }

    const roll = Math.random();

    if (roll < 0.60 && model.hotRanges.length > 0) {
        // Wybierz losowo jeden z gorących przedziałów (ważony przez score)
        const totalScore = model.hotRanges.reduce((s, r) => s + r.score, 0);
        let pick = Math.random() * totalScore;
        for (const range of model.hotRanges) {
            pick -= range.score;
            if (pick <= 0) {
                // Losuj nonce wewnątrz tego przedziału
                return Math.floor(range.lo + Math.random() * (range.hi - range.lo));
            }
        }
    }

    if (roll < 0.90) {
        // Losowy nonce z całego zakresu 32-bit
        return Math.floor(Math.random() * MAX_NONCE);
    }

    // Zacznij od 0 (klasyczna iteracja)
    return 0;
}

// ─── Zapisz model do pliku JSON ───────────────────────────────────────────────
function saveModel(stats, blocks) {
    const model = {
        version: 1,
        createdAt: new Date().toISOString(),
        blockCount: stats.count,
        heightRange: {
            from: Math.min(...blocks.map(b => b.height)),
            to: Math.max(...blocks.map(b => b.height)),
        },
        stats: {
            min: stats.min,
            max: stats.max,
            mean: stats.mean,
            median: stats.median,
            stddev: stats.stddev,
            p10: stats.p10,
            p25: stats.p25,
            p75: stats.p75,
            p90: stats.p90,
            isUniform: stats.isUniform,
            chiSquare: stats.chiSquare,
            coverage: Math.round(stats.coverage * 10000) / 100,
        },
        histogram: stats.histogram,
        hotRanges: stats.hotRanges,
        clusters: stats.clusters,
        rawNonces: blocks.map(b => b.nonce), // surowe dane do ewentualnej re-analizy
    };

    fs.writeFileSync(MODEL_FILE, JSON.stringify(model, null, 2));
    return model;
}

// ─── Wczytaj model z pliku ────────────────────────────────────────────────────
function loadModel(filePath) {
    const fp = filePath || MODEL_FILE;
    if (!fs.existsSync(fp)) return null;
    try {
        return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch (e) {
        return null;
    }
}

// ─── Wydrukuj raport ──────────────────────────────────────────────────────────
function printReport(stats, model) {
    const fmtN = n => n.toLocaleString('pl-PL');
    const fmtP = n => ((n / MAX_NONCE) * 100).toFixed(2) + '%';

    console.log(`\n${c(C.orange + C.bold, '📊 RAPORT ANALIZY NONCE')}`);
    console.log(c(C.gray, '═'.repeat(62)));

    // Statystyki podstawowe
    console.log(`\n${c(C.yellow, '  STATYSTYKI PODSTAWOWE:')}`);
    console.log(`  Przeanalizowanych bloków: ${c(C.white, fmtN(stats.count))}`);
    console.log(`  Min nonce:  ${c(C.cyan, fmtN(stats.min))}  (${fmtP(stats.min)} zakresu)`);
    console.log(`  Max nonce:  ${c(C.cyan, fmtN(stats.max))}  (${fmtP(stats.max)} zakresu)`);
    console.log(`  Średnia:    ${c(C.cyan, fmtN(stats.mean))}`);
    console.log(`  Mediana:    ${c(C.cyan, fmtN(stats.median))}`);
    console.log(`  Odch. std:  ${c(C.cyan, fmtN(stats.stddev))}`);
    console.log(`  Pokrycie:   ${c(C.cyan, (stats.coverage * 100).toFixed(1) + '% zakresu 32-bit')}`);

    // Percentyle
    console.log(`\n${c(C.yellow, '  PERCENTYLE:')}`);
    console.log(`  P10: ${c(C.cyan, fmtN(stats.p10))}  P25: ${c(C.cyan, fmtN(stats.p25))}  P75: ${c(C.cyan, fmtN(stats.p75))}  P90: ${c(C.cyan, fmtN(stats.p90))}`);

    // Test jednorodności
    console.log(`\n${c(C.yellow, '  TEST JEDNORODNOŚCI (chi-kwadrat):')}`);
    const uColor = stats.isUniform ? C.green : C.yellow;
    console.log(`  χ² = ${c(C.cyan, stats.chiSquare)}  →  ${c(uColor, stats.isUniform ? '✅ Rozkład jednorodny (p>0.05)' : '⚠️  Rozkład NIE jest jednorodny (p<0.05)')}`);
    if (!stats.isUniform) {
        console.log(c(C.gray, '  Wykryto skupiska – pewne przedziały są bardziej popularne'));
    }

    // Histogram
    console.log(`\n${c(C.yellow, '  HISTOGRAM (16 przedziałów × ~268M):')}`);
    const maxBin = Math.max(...stats.histogram);
    const binSize = MAX_NONCE / 16;
    stats.histogram.forEach((count, i) => {
        const lo = Math.floor(i * binSize);
        const hi = Math.floor((i + 1) * binSize);
        const bar = '█'.repeat(Math.round(count / maxBin * 25)).padEnd(25, '░');
        const pct = (count / stats.count * 100).toFixed(1).padStart(5);
        const mark = stats.topBins.some(t => t.bin === i) ? c(C.orange, ' ◄ HOT') : '';
        const loFmt = (lo / 1e9).toFixed(2).padStart(5);
        const hiFmt = (hi / 1e9).toFixed(2).padStart(5);
        console.log(`  [${loFmt}G–${hiFmt}G] ${c(C.orange, bar)} ${pct}% (${count})${mark}`);
    });

    // Gorące przedziały
    console.log(`\n${c(C.yellow, '  🔥 GORĄCE PRZEDZIAŁY (największa gęstość historyczna):')}`);
    stats.hotRanges.forEach((r, i) => {
        const lo = (r.lo / 1e9).toFixed(3);
        const hi = (r.hi / 1e9).toFixed(3);
        console.log(
            `  #${i + 1} [${c(C.cyan, lo + 'G')} – ${c(C.cyan, hi + 'G')}]` +
            `  źródło: ${c(C.gray, r.source)}  score: ${c(C.orange, r.score)}`
        );
    });

    // Klastry
    if (stats.clusters.length > 0) {
        console.log(`\n${c(C.yellow, '  📍 WYKRYTE SKUPISKA:')}`);
        stats.clusters.forEach((cl, i) => {
            const lo = (cl.lo / 1e9).toFixed(3);
            const hi = (cl.hi / 1e9).toFixed(3);
            console.log(
                `  Klaster ${i + 1}: [${c(C.cyan, lo + 'G')} – ${c(C.cyan, hi + 'G')}]` +
                `  ${c(C.green, cl.count + ' bloków')}  środek: ${c(C.white, fmtN(cl.center))}`
            );
        });
    }

    // Wnioski
    console.log(`\n${c(C.yellow, '  💡 WNIOSKI:')}`);
    if (stats.isUniform) {
        console.log(c(C.gray, '  Rozkład jest praktycznie jednorodny – nonce są losowe.'));
        console.log(c(C.gray, '  Nie ma statystycznie uzasadnionego "lepszego" przedziału.'));
        console.log(c(C.gray, '  Sugerowanie nonce na podstawie historii = iluzja przewagi.'));
    } else {
        console.log(c(C.orange, '  Wykryto niejednorodność – pewne minery preferują zakres.'));
        console.log(c(C.orange, '  Gorące przedziały mogą odzwierciedlać implementację minerów.'));
        console.log(c(C.gray, '  Matematycznie: to NIE zwiększa szans na znalezienie bloku.'));
    }

    // Info o modelu
    console.log(`\n${c(C.green, '  ✅ Model zapisany do:')} ${MODEL_FILE}`);
    console.log(c(C.gray, `  Importuj w solo-miner.js:`));
    console.log(c(C.cyan, `  const { suggestNonce, loadModel } = require('./nonce-analyzer');`));
    console.log(c(C.cyan, `  const model  = loadModel();`));
    console.log(c(C.cyan, `  const nonce0 = suggestNonce(model);  // nonce startowy`));
    console.log(c(C.gray, '═'.repeat(62)));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function drawBar(current, max, width) {
    const fill = Math.floor(Math.min(current / max, 1) * width);
    return `[${c(C.orange, '█'.repeat(fill))}${c(C.gray, '░'.repeat(width - fill))}]`;
}

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { blocks: 500, help: false, model: 'nonce-model.json' };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--blocks') opts.blocks = parseInt(args[++i]);
        if (args[i] === '--help' || args[i] === '-h') opts.help = true;
        if (args[i] === '--model') opts.model = args[++i];
    }
    return opts;
}

function printHelp() {
    console.log(`
${c(C.orange + C.bold, '📊 Monero Nonce Analyzer')}

UŻYCIE:
  node nonce-analyzer.js [--blocks N]

OPCJE:
  --blocks N    Liczba bloków do analizy (domyślnie: 500)
  --help        Pokaż tę pomoc

IMPORT W SOLO-MINER:
  const { suggestNonce, loadModel } = require('./nonce-analyzer');
  const model = loadModel();       // wczytaj gotowy model
  const start = suggestNonce(model); // sugerowany nonce startowy
`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {

    if (opts.help) { printHelp(); return; }

    console.log(`\n${c(C.orange + C.bold, '📊 MONERO NONCE ANALYZER')}`);
    console.log(c(C.gray, '═'.repeat(62)));

    // 1. Pobierz aktualną wysokość
    console.log(`\n  ${c(C.cyan, 'Pobieranie aktualnej wysokości blokchainu...')}`);
    let topHeight;
    try {
        topHeight = await getCurrentHeight();
        console.log(`  Aktualny blok: ${c(C.white, topHeight.toLocaleString('pl-PL'))}`);
    } catch (e) {
        console.error(c(C.red, `  ❌ Błąd: ${e.message}`));
        console.error(c(C.yellow, '  Sprawdź połączenie z internetem.'));
        process.exit(1);
    }

    // 2. Pobierz nonce z bloków
    console.log(`\n  ${c(C.cyan, `Pobieram nonce z ${opts.blocks} bloków (concurrency=10)...`)}\n`);
    let blocks;
    try {
        blocks = await fetchBlocks(topHeight, opts.blocks, 10);
    } catch (e) {
        console.error(c(C.red, `\n  ❌ Błąd pobierania: ${e.message}`));
        process.exit(1);
    }

    if (blocks.length < 10) {
        console.error(c(C.red, `\n  ❌ Za mało danych (${blocks.length} bloków). Sprawdź API.`));
        process.exit(1);
    }

    console.log(`\n  Pobrano: ${c(C.green, blocks.length + ' bloków')}`);

    // 3. Analiza
    console.log(`  ${c(C.cyan, 'Analizuję rozkład...')}`);
    const stats = analyzeNonces(blocks);

    // 4. Zapisz model
    const model = saveModel(stats, blocks);

    // 5. Raport
    printReport(stats, model);

    // 6. Demo suggestNonce
    console.log(`\n${c(C.yellow + C.bold, '  🎯 DEMO suggestNonce() – 10 przykładowych wartości:')}`);
    for (let i = 0; i < 10; i++) {
        const ns = suggestNonce(model);
        const range = model.hotRanges.find(r => ns >= r.lo && ns <= r.hi);
        const tag = range ? c(C.orange, `[HOT: ${range.source}]`) : c(C.gray, '[random]');
        console.log(`  ${c(C.cyan, ns.toLocaleString('pl-PL').padStart(16))}  0x${ns.toString(16).toUpperCase().padStart(8, '0')}  ${tag}`);
    }
    console.log();
}

// ─── EKSPORT dla solo-miner.js ────────────────────────────────────────────────
module.exports = { suggestNonce, loadModel, analyzeNonces };

// ─── Uruchom jeśli wywołany bezpośrednio ─────────────────────────────────────
if (require.main === module) {
    main().catch(e => {
        console.error(c(C.red, `\n❌ Błąd krytyczny: ${e.message}`));
        process.exit(1);
    });
}