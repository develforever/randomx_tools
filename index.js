#!/usr/bin/env node
/**
 * ============================================================
 *  Monero Solo Miner – CLI
 *  Pobiera block_template z węzła → szuka nonce → submit_block
 *
 *  WYMAGANIA:
 *    npm install randomx.js    ← PRAWDZIWY RandomX (zalecane)
 *    Node.js 16+
 *
 *  UŻYCIE:
 *    node solo-miner.js --address TWÓJ_ADRES_XMR
 *    node solo-miner.js --address TWÓJ_ADRES_XMR --node http://node.moneroworld.com:18089
 *    node solo-miner.js --address TWÓJ_ADRES_XMR --threads 8
 *    node solo-miner.js --help
 *
 *  WAŻNE: Ta wersja używa SHA-256 jako placeholder dla RandomX.
 *  Aby używać prawdziwego RandomX: npm install randomx.js
 *  i ustaw USE_REAL_RANDOMX = true poniżej.
 * ============================================================
 */

'use strict';

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

// ─── KONFIGURACJA ────────────────────────────────────────────────────────────
const USE_REAL_RANDOMX = true;  // ← zmień na true po: npm install randomx.js

// Publiczne węzły Monero (port 18089 = restricted RPC, obsługuje get_block_template)
const PUBLIC_NODES = [
    'http://node.moneroworld.com:18089',
    'http://nodes.hashvault.pro:18081',
    'http://node.community.rino.io:18081',
    'http://opennode.xmr-tw.org:18089',
    'http://p2pmd.xmr-tw.org:18089',
];

// ─── Kolory ANSI ─────────────────────────────────────────────────────────────
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    orange: '\x1b[38;5;208m', green: '\x1b[32m', red: '\x1b[31m',
    cyan: '\x1b[36m', yellow: '\x1b[33m', gray: '\x1b[90m',
    white: '\x1b[97m', magenta: '\x1b[35m',
};
const c = (color, s) => `${color}${s}${C.reset}`;

const { StrategyEngine, createStrategyState, suggestNonceStrategic } = require('./nonce-strategies');
const { loadModel } = require('./nonce-analyzer');

const model = loadModel();
const engine = createStrategyState(model.hotRanges);

// ─── Parse args ──────────────────────────────────────────────────────────────
function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        address: null,
        node: null,
        threads: 1,
        help: false,
        testMode: false,   // --test: tryb testowy bez prawdziwego mining
    };
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--address': opts.address = args[++i]; break;
            case '--node': opts.node = args[++i]; break;
            case '--threads': opts.threads = parseInt(args[++i]); break;
            case '--test': opts.testMode = true; break;
            case '--help': case '-h': opts.help = true; break;
        }
    }
    return opts;
}

// ─── Pomoc ───────────────────────────────────────────────────────────────────
function printHelp() {
    console.log(`
${c(C.orange + C.bold, '⛏️  Monero Solo Miner – CLI')}
${c(C.gray, '─'.repeat(58))}

${c(C.yellow, 'UŻYCIE:')}
  node solo-miner.js --address <TWÓJ_ADRES_XMR> [opcje]

${c(C.yellow, 'OPCJE:')}
  ${c(C.cyan, '--address <adres>')}   Twój adres XMR (wymagany)
  ${c(C.cyan, '--node    <url>')}     URL węzła monerod (opcjonalny)
                         Domyślnie: auto-wybór z listy publicznych
  ${c(C.cyan, '--threads <n>')}       Liczba wątków (domyślnie: 1)
  ${c(C.cyan, '--test')}              Tryb testowy (symuluje template bez sieci)
  ${c(C.cyan, '--help')}              Pokaż tę pomoc

${c(C.yellow, 'PRZYKŁADY:')}
  node solo-miner.js --address 44ABC...XYZ
  node solo-miner.js --address 44ABC...XYZ --threads 8
  node solo-miner.js --address 44ABC...XYZ --node http://127.0.0.1:18081
  node solo-miner.js --test

${c(C.yellow, 'JAK DZIAŁA:')}
  1. Łączy się z węzłem Monero przez JSON-RPC
  2. Pobiera get_block_template (blob + seed_hash + difficulty)
  3. Wstawia nonce (4B little-endian) do bajtu 39 blockhashing_blob
  4. Liczy RandomX(seed_hash, blob) → sprawdza hash < target
  5. Jeśli tak → submit_block do sieci → dostaje nagrodę 0.6 XMR

${c(C.yellow, 'PRAWDZIWY RANDOMX:')}
  npm install randomx.js
  Następnie zmień USE_REAL_RANDOMX = true w pliku

${c(C.gray, '─'.repeat(58))}
`);
}

// ─── HTTP/HTTPS JSON-RPC ─────────────────────────────────────────────────────
function rpcCall(nodeUrl, method, params = {}) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            jsonrpc: '2.0',
            id: '0',
            method,
            params,
        });

        const url = new URL(nodeUrl + '/json_rpc');
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;

        const reqOpts = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: 10000,
        };

        const req = lib.request(reqOpts, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) reject(new Error(`RPC error: ${parsed.error.message}`));
                    else resolve(parsed.result);
                } catch (e) {
                    reject(new Error(`JSON parse error: ${e.message}`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(body);
        req.end();
    });
}

// ─── Znajdź działający węzeł ─────────────────────────────────────────────────
async function findWorkingNode(nodes) {
    for (const node of nodes) {
        try {
            process.stdout.write(`  Próbuję ${c(C.cyan, node)} ... `);
            const info = await rpcCall(node, 'get_info');
            if (info && info.status === 'OK') {
                console.log(c(C.green, '✅ OK') + ` (blok #${info.height})`);
                return node;
            }
        } catch (e) {
            console.log(c(C.red, '❌ ' + e.message.slice(0, 40)));
        }
    }
    return null;
}

// ─── Pobierz block template ──────────────────────────────────────────────────
async function getBlockTemplate(node, address) {
    return await rpcCall(node, 'get_block_template', {
        wallet_address: address,
        reserve_size: 8,
    });
}

// ─── Submit block ────────────────────────────────────────────────────────────
async function submitBlock(node, blobHex) {
    return await rpcCall(node, 'submit_block', [blobHex]);
}

// ─── HASH ENGINE ─────────────────────────────────────────────────────────────
let rxVM = null;

function initHashEngine(seedHex) {
    if (USE_REAL_RANDOMX) {
        try {
            const { randomx_create_vm, randomx_init_cache } = require('randomx.js');
            const seedBuf = Buffer.from(seedHex, 'hex');
            const cache = randomx_init_cache(seedBuf);
            rxVM = randomx_create_vm(cache);
            return 'randomx';
        } catch (e) {
            console.log(c(C.yellow, '  ⚠️  randomx.js niedostępne, używam SHA-256'));
        }
    }
    return 'sha256';
}

function calcHash(data) {
    if (rxVM) {
        return Buffer.from(rxVM.calculate_hash(data));
    }
    // SHA-256 placeholder
    return crypto.createHash('sha256').update(data).digest();
}

// ─── Wstaw nonce do blockhashing_blob ────────────────────────────────────────
// Struktura blockhashing_blob:
//   bajty 0-38:  nagłówek (major_version, minor_version, timestamp, prev_hash...)
//   bajty 39-42: NONCE (4 bajty little-endian) ← tutaj wpisujemy
//   bajty 43+:   merkle root i reszta
function insertNonce(blobHex, nonce) {
    const buf = Buffer.from(blobHex, 'hex');
    buf.writeUInt32LE(nonce, 39);
    return buf;
}

// ─── Oblicz target z difficulty ──────────────────────────────────────────────
// target = floor(2^256 / difficulty)
// W Monero difficulty to 64-bit liczba (lub 128-bit w wide_difficulty)
function difficultyToTarget(difficulty) {
    // Obliczamy target jako 256-bitowy bufor
    // target = 0xFFFF...FFFF / difficulty (uproszczenie: 2^64 / diff dla porównania)
    const MAX = BigInt('0x' + 'ff'.repeat(32));
    const diff = BigInt(difficulty);
    const target = MAX / diff;
    const hex = target.toString(16).padStart(64, '0');
    return Buffer.from(hex, 'hex');
}

// ─── Czy hash spełnia target (hash < target) ─────────────────────────────────
function meetsTarget(hashBuf, targetBuf) {
    for (let i = 0; i < 32; i++) {
        if (hashBuf[i] < targetBuf[i]) return true;
        if (hashBuf[i] > targetBuf[i]) return false;
    }
    return true;
}

// ─── Zamień blockhashing_blob na blocktemplate_blob z nowym nonce ─────────────
// Po znalezieniu nonce musimy go wstawić do blocktemplate_blob (nie do blockhashing_blob)
// i wysłać ten blob jako submit_block
function prepareSubmitBlob(templateBlob, nonce) {
    const buf = Buffer.from(templateBlob, 'hex');
    buf.writeUInt32LE(nonce, 39);
    return buf.toString('hex');
}

// ─── Formatowanie ────────────────────────────────────────────────────────────
function fmtHashrate(hps) {
    if (hps >= 1e9) return `${(hps / 1e9).toFixed(2)} GH/s`;
    if (hps >= 1e6) return `${(hps / 1e6).toFixed(2)} MH/s`;
    if (hps >= 1e3) return `${(hps / 1e3).toFixed(2)} KH/s`;
    return `${Math.round(hps)} H/s`;
}
function fmtTime(ms) {
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}
function fmtNum(n) { return n.toLocaleString('pl-PL'); }

// ─── Generuj testowy template (bez sieci) ────────────────────────────────────
function makeTestTemplate() {
    // Symulacja odpowiedzi get_block_template
    const fakeBlob = '0' + '0'.repeat(77) + '00000000' + '0'.repeat(138);
    return {
        blockhashing_blob: fakeBlob,
        blocktemplate_blob: fakeBlob,
        seed_hash: 'a61293c1bfda814eaa4d8a0f7c35d63dbcfe8fcd82b51b1edfd56ccf4c6f78c0',
        difficulty: 65536,     // bardzo łatwy dla testu
        height: 9999999,
        prev_hash: '0'.repeat(64),
        reserved_offset: 43,
        status: 'OK',
    };
}

// ─── GŁÓWNA PĘTLA MININGU ─────────────────────────────────────────────────────
async function mineLoop(node, address, opts) {
    const MAX_NONCE = 0xFFFFFFFF;
    const REPORT_EVERY = 25000;     // raportuj co 25k hashy
    const REFRESH_EVERY = 30000;    // nowy template co 30 sekund (nowy blok!)

    let totalBlocks = 0;
    let sessionStart = Date.now();

    console.log(`\n${c(C.orange + C.bold, '⛏️  MINING ROZPOCZĘTY')}`);
    console.log(c(C.gray, '═'.repeat(60)));

    // eslint-disable-next-line no-constant-condition
    while (true) {
        // ── 1. Pobierz nowy template ──────────────────────────────────────────
        let template;
        try {
            if (opts.testMode) {
                template = makeTestTemplate();
                console.log(c(C.yellow, '\n  [TEST MODE] używam symulowany template'));
            } else {
                process.stdout.write(`\n  ${c(C.cyan, 'Pobieranie block_template...')} `);
                template = await getBlockTemplate(node, address);
                console.log(c(C.green, '✅'));
            }
        } catch (e) {
            console.log(c(C.red, `\n❌ Błąd pobierania template: ${e.message}`));
            console.log(c(C.yellow, '  Ponawiam za 5s...'));
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }

        const {
            blockhashing_blob: hashBlob,
            blocktemplate_blob: templateBlob,
            seed_hash,
            difficulty,
            height,
        } = template;

        // ── 2. Inicjuj hash engine (jeśli seed się zmienił) ──────────────────
        const hashEngine = initHashEngine(seed_hash);

        // ── 3. Oblicz target ──────────────────────────────────────────────────
        const targetBuf = difficultyToTarget(difficulty);

        console.log(c(C.gray, '  ─'.repeat(30)));
        console.log(`  ${c(C.cyan, 'Blok #:')}    ${c(C.white, fmtNum(height))}`);
        console.log(`  ${c(C.cyan, 'Difficulty:')} ${c(C.white, fmtNum(difficulty))}`);
        console.log(`  ${c(C.cyan, 'Seed hash:')} ${seed_hash.slice(0, 16)}...`);
        console.log(`  ${c(C.cyan, 'Target:')}    ${targetBuf.toString('hex').slice(0, 16)}...`);
        console.log(`  ${c(C.cyan, 'Hash fn:')}   ${hashEngine === 'randomx' ? c(C.green, 'RandomX ✅') : c(C.yellow, 'SHA-256 (placeholder)')}`);
        console.log(c(C.gray, '  ─'.repeat(30)));

        // ── 4. Główna pętla nonce ─────────────────────────────────────────────
        engine.setSeed(template.seed_hash);
        let nonce = suggestNonceStrategic(engine, true);
        let count = 0;
        let roundStart = Date.now();
        let lastReport = Date.now();
        let found = false;
        let templateAge = Date.now();

        while (nonce <= MAX_NONCE) {
            // Sprawdź czy czas odświeżyć template (nowy blok w sieci!)
            if (!opts.testMode && Date.now() - templateAge > REFRESH_EVERY) {
                console.log(c(C.yellow, '\n  ⟳ Odświeżam template (nowy blok w sieci)...'));
                break; // wróć do pętli zewnętrznej
            }

            // Wstaw nonce do bloba i hash
            const blobBuf = insertNonce(hashBlob, nonce);
            const hash = calcHash(blobBuf);
            count++;

            // Sprawdź czy spełnia trudność
            if (meetsTarget(hash, targetBuf)) {
                found = true;
                const elapsed = Date.now() - roundStart;
                const rate = Math.round(count / (elapsed / 1000));

                console.log(`\n\n${c(C.green + C.bold, '🎉 ZNALEZIONO WAŻNY NONCE!')}`);
                console.log(c(C.gray, '═'.repeat(60)));
                console.log(`  ${c(C.cyan, 'Nonce (dec):')}  ${c(C.green + C.bold, fmtNum(nonce))}`);
                console.log(`  ${c(C.cyan, 'Nonce (hex):')}  ${c(C.green, '0x' + nonce.toString(16).toUpperCase().padStart(8, '0'))}`);
                const nonceLEBuf = Buffer.allocUnsafe(4); nonceLEBuf.writeUInt32LE(nonce, 0);
                console.log(`  ${c(C.cyan, 'Nonce (LE):')}   ${nonceLEBuf.toString('hex').toUpperCase()}`);
                console.log(`  ${c(C.cyan, 'Hash:')}         ${c(C.green, hash.toString('hex'))}`);
                console.log(`  ${c(C.cyan, 'Blok #:')}       ${fmtNum(height)}`);
                console.log(`  ${c(C.cyan, 'Prób:')}         ${fmtNum(count)}`);
                console.log(`  ${c(C.cyan, 'Czas:')}         ${fmtTime(elapsed)}`);
                console.log(`  ${c(C.cyan, 'Hashrate:')}     ${fmtHashrate(rate)}`);
                console.log(c(C.gray, '═'.repeat(60)));

                // ── 5. Submit block ──────────────────────────────────────────────
                if (!opts.testMode) {
                    const submitBlob = prepareSubmitBlob(templateBlob, nonce);
                    console.log(`\n  ${c(C.cyan, 'Wysyłam blok do sieci...')}`);
                    try {
                        const result = await submitBlock(node, submitBlob);
                        if (result && result.status === 'OK') {
                            totalBlocks++;
                            console.log(c(C.green + C.bold, `\n  ✅ BLOK ZAAKCEPTOWANY! Nagroda: 0.6 XMR`));
                            console.log(`  ${c(C.cyan, 'Łącznie znalezionych bloków:')} ${totalBlocks}`);
                            engine.reward(foundNonce);
                            engine.printStatus();
                        } else {
                            console.log(c(C.red, `\n  ❌ Blok odrzucony: ${JSON.stringify(result)}`));
                        }
                    } catch (e) {
                        console.log(c(C.red, `\n  ❌ Błąd submit: ${e.message}`));
                    }
                } else {
                    console.log(c(C.green, '\n  [TEST] Blok zostałby wysłany do sieci!'));
                    console.log(`  ${c(C.cyan, 'submit blob:')} ${prepareSubmitBlob(templateBlob, nonce).slice(0, 32)}...`);
                    // W trybie testowym kończymy po znalezieniu
                    process.exit(0);
                }

                break; // wróć do pętli zewnętrznej po znalezieniu
            }

            // ── Raport postępu ────────────────────────────────────────────────
            if (count % REPORT_EVERY === 0) {
                const now = Date.now();
                const elapsed = (now - lastReport) / 1000;
                const rate = Math.round(REPORT_EVERY / elapsed);
                const total = now - roundStart;
                const pctNonce = ((nonce / MAX_NONCE) * 100).toFixed(3);

                const bar = drawBar(nonce, MAX_NONCE, 20);
                process.stdout.write(
                    `\r  ${bar} ` +
                    `${c(C.cyan, '#' + fmtNum(height))} ` +
                    `nonce:${c(C.white, fmtNum(nonce))} ` +
                    `${c(C.orange, fmtHashrate(rate))} ` +
                    `[${c(C.gray, fmtTime(total))}]    `
                );

                lastReport = now;
            }

            engine.setSeed(template.seed_hash);
            nonce = suggestNonceStrategic(engine, true);
        }

        if (!found && nonce > MAX_NONCE) {
            // Wyczerpaliśmy cały zakres 32-bit bez wyniku
            // To może się zdarzyć przy bardzo wysokiej trudności
            // → odświeżamy template (z nowym extra_nonce w coinbase automatycznie)
            console.log(c(C.yellow, '\n  ⚠️  Wyczerpano nonce 32-bit → pobieranie nowego template'));
        }
    }
}

// ─── Pasek postępu ────────────────────────────────────────────────────────────
function drawBar(current, max, width) {
    const pct = Math.min(current / max, 1);
    const fill = Math.floor(pct * width);
    return `[${c(C.orange, '█'.repeat(fill))}${c(C.gray, '░'.repeat(width - fill))}]`;
}

// ─── Walidacja adresu XMR ─────────────────────────────────────────────────────
function validateXMRAddress(addr) {
    if (!addr) return false;
    // Adres główny Monero: zaczyna od '4', długość 95 znaków, base58
    // Adres subaddress: zaczyna od '8', długość 95 znaków
    // Uproszczona walidacja
    return /^[48][0-9A-Za-z]{94}$/.test(addr);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
    const opts = parseArgs();

    console.log(`\n${c(C.orange + C.bold, '⛏️  MONERO SOLO MINER')}`);
    console.log(c(C.gray, '═'.repeat(60)));

    if (opts.help) {
        printHelp();
        process.exit(0);
    }

    // Tryb testowy – nie potrzebuje adresu
    if (opts.testMode) {
        console.log(c(C.yellow, '\n  ⚙️  TRYB TESTOWY – bez połączenia z siecią\n'));
        await mineLoop(null, 'TESTADDRESS', opts);
        return;
    }

    // Walidacja adresu
    if (!opts.address) {
        console.log(c(C.red, '\n❌ Brak adresu! Użyj: node solo-miner.js --address TWÓJ_ADRES_XMR'));
        console.log(c(C.yellow, '   lub: node solo-miner.js --test (tryb testowy)\n'));
        process.exit(1);
    }

    if (!validateXMRAddress(opts.address)) {
        console.log(c(C.red, `\n❌ Nieprawidłowy adres XMR: ${opts.address}`));
        console.log(c(C.yellow, '   Adres powinien mieć 95 znaków i zaczynać się od "4" lub "8"\n'));
        process.exit(1);
    }

    console.log(`\n  ${c(C.cyan, 'Adres XMR:')}  ${opts.address.slice(0, 20)}...${opts.address.slice(-10)}`);
    console.log(`  ${c(C.cyan, 'Wątki:')}      ${opts.threads}`);
    console.log(`  ${c(C.cyan, 'Hash fn:')}    ${USE_REAL_RANDOMX ? c(C.green, 'RandomX') : c(C.yellow, 'SHA-256 (placeholder)')}`);

    // ── Znajdź węzeł ────────────────────────────────────────────────────────
    let node = opts.node;
    if (!node) {
        console.log(`\n${c(C.cyan, '  Szukam działającego węzła Monero...')}`);
        node = await findWorkingNode(PUBLIC_NODES);
        if (!node) {
            console.log(c(C.red, '\n❌ Brak połączenia z żadnym węzłem!'));
            console.log(c(C.yellow, '  Spróbuj:'));
            console.log(c(C.yellow, '  • Podaj własny węzeł: --node http://127.0.0.1:18081'));
            console.log(c(C.yellow, '  • Uruchom lokalnego monerod'));
            console.log(c(C.yellow, '  • Sprawdź firewall/internet'));
            console.log(c(C.yellow, '  • Tryb testowy: --test'));
            process.exit(1);
        }
    } else {
        console.log(`\n  ${c(C.cyan, 'Węzeł:')} ${node}`);
    }

    console.log(`\n  ${c(C.green, '✅ Połączono z:')} ${node}`);

    // ── Info o szansach ──────────────────────────────────────────────────────
    console.log(`\n${c(C.yellow + C.bold, '  ℹ️  INFORMACJA O SZANSACH:')}`);
    console.log(c(C.gray, '  Trudność sieci ~716 mld → czas do bloku solo (EPYC): ~276 dni'));
    console.log(c(C.gray, '  SHA-256 placeholder ≠ RandomX → hashrate nie przekłada się na XMR'));
    console.log(c(C.gray, '  Zainstaluj randomx.js aby używać prawdziwego algorytmu'));

    // ── Start mining ─────────────────────────────────────────────────────────
    await mineLoop(node, opts.address, opts);
}

// ─── Obsługa Ctrl+C ──────────────────────────────────────────────────────────
process.on('SIGINT', () => {
    console.log(`\n\n${c(C.yellow, '  ⏹️  Zatrzymano przez użytkownika')}`);
    process.exit(0);
});

main().catch(e => {
    console.error(c(C.red, `\n❌ Błąd krytyczny: ${e.message}`));
    process.exit(1);
});