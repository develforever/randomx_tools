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
const fs = require('fs');                                          // #2 FIX: brakujący import
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

// ─── KONFIGURACJA ────────────────────────────────────────────────────────────
const USE_REAL_RANDOMX = true;  // ← zmień na true po: npm install randomx.js

const MODEL_FILE = 'nonce-model.json';
const ENGINE_FILE = 'engine-state.json'; // #3 FIX: stan silnika osobno od modelu

const { StrategyEngine, createStrategyState, suggestNonceStrategic } = require('./nonce-strategies');
const { loadModel } = require('./nonce-analyzer');
const { rpcCall, findWorkingNode, PUBLIC_NODES } = require('./nodes-api');
const { c, C, drawBar } = require('./cli-util');
const { applyExtraNonce, rebuildHashBlob } = require('./merkle-util'); // #4 FIX: lokalny merkle

const model = loadModel(MODEL_FILE);
if (!model) {
    console.error(`❌ Brak modelu ${MODEL_FILE}. Uruchom: node nonce-analyzer.js`);
    process.exit(1);
}
// #1 FIX: tylko hotRanges — nie przekazuj całego modelu jako saved
const engine = createStrategyState(model.hotRanges);
if (fs.existsSync(ENGINE_FILE)) {
    try {
        engine.importState(JSON.parse(fs.readFileSync(ENGINE_FILE, 'utf8')));
    } catch (_) {
        console.log('  ⚠️  Błąd wczytywania engine-state.json, startujemy od nowa');
    }
}

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
//   bajty 43+:   merkle root
//
// UWAGA: zwraca ten sam bufor roboczy za każdym razem (nie tworzy kopii).
// Caller musi go użyć zanim następne wywołanie go nadpisze.
let _workBuf = null;
function insertNonce(blob, nonce) {
    // Przy pierwszym wywołaniu lub zmianie bloba (nowy hashBlob po extra_nonce)
    // inicjuj bufor roboczy
    const src = Buffer.isBuffer(blob) ? blob : Buffer.from(blob, 'hex');
    if (!_workBuf || _workBuf.length !== src.length) {
        _workBuf = Buffer.from(src);
    } else if (_workBuf !== src) {
        src.copy(_workBuf);
    }
    _workBuf.writeUInt32LE(nonce >>> 0, 39);
    return _workBuf;
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
    const REPORT_EVERY = 10000;  // raportuj co 10k hashy
    const CHECK_EVERY = 5000;    // sprawdzaj nowy blok co 5s
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

        // ── 4. Inicjalizacja pętli nonce ─────────────────────────────────────
        engine.setSeed(seed_hash);
        let hashBlobBuf = Buffer.from(hashBlob, 'hex');
        let templateBlobBuf = Buffer.from(templateBlob, 'hex');
        let extraNonce = 0;
        let count = 0;
        let roundStart = Date.now();
        let lastReport = Date.now();
        let lastCheck = Date.now(); // #6 FIX: osobny timer dla CHECK_EVERY
        let found = false;
        let newBlock = false;

        // ── 5. Pętla extra_nonce ──────────────────────────────────────────────
        // Przy każdym wyczerpaniu nonce 32-bit: inkrementuj extra_nonce,
        // przelicz merkle lokalnie (bez round-trip do węzła) i szukaj dalej.
        while (!found && !newBlock) {

            if (extraNonce > 0) {
                // #4 FIX: poprawna obsługa extra_nonce przez merkle-util
                templateBlobBuf = applyExtraNonce(templateBlobBuf, template.reserved_offset, extraNonce);
                hashBlobBuf = rebuildHashBlob(templateBlobBuf, hashBlobBuf);
                _workBuf = null; // reset bufora roboczego — nowy hashBlob
                console.log(c(C.yellow,
                    `\n  ⚠️  Wyczerpano nonce 32-bit → extra_nonce=${extraNonce} → nowy hashBlob`
                ));
            }

            // Sugestia silnika: startujemy z górnego zakresu (mirror algo)
            const startNonce = suggestNonceStrategic(engine, true);
            let nonce = startNonce;
            // #5 FIX: dwie fazy — góra (startNonce→MAX) i dół (0→startNonce)
            let phase = 'góra';

            // ── 6. Pętla nonce 32-bit ─────────────────────────────────────────
            while (true) {

                // #6 FIX: sprawdzaj nowy blok tylko co CHECK_EVERY ms
                if (!opts.testMode && Date.now() - lastCheck > CHECK_EVERY) {
                    lastCheck = Date.now();
                    try {
                        const fresh = await getBlockTemplate(node, address);
                        if (fresh.height > height) {
                            console.log(c(C.yellow, `\n  ⟳ Nowy blok #${fresh.height} → reset`));
                            newBlock = true;
                            break;
                        }
                    } catch (_) { /* węzeł niedostępny chwilowo – kontynuuj */ }
                }

                // Hash
                const blobBuf = insertNonce(hashBlobBuf, nonce);
                const hash = calcHash(blobBuf);
                count++;

                if (meetsTarget(hash, targetBuf)) {
                    found = true;
                    const elapsed = Date.now() - roundStart;
                    const rate = Math.round(count / (elapsed / 1000));

                    console.log(`\n\n${c(C.green + C.bold, '🎉 ZNALEZIONO WAŻNY NONCE!')}`);
                    console.log(c(C.gray, '═'.repeat(60)));
                    console.log(`  ${c(C.cyan, 'Nonce (dec):')}   ${c(C.green + C.bold, fmtNum(nonce))}`);
                    console.log(`  ${c(C.cyan, 'Nonce (hex):')}   ${c(C.green, '0x' + nonce.toString(16).toUpperCase().padStart(8, '0'))}`);
                    const nonceLEBuf = Buffer.allocUnsafe(4); nonceLEBuf.writeUInt32LE(nonce, 0);
                    console.log(`  ${c(C.cyan, 'Nonce (LE):')}    ${nonceLEBuf.toString('hex').toUpperCase()}`);
                    console.log(`  ${c(C.cyan, 'Extra nonce:')}   ${extraNonce}`);
                    console.log(`  ${c(C.cyan, 'Hash:')}          ${c(C.green, hash.toString('hex'))}`);
                    console.log(`  ${c(C.cyan, 'Blok #:')}        ${fmtNum(height)}`);
                    console.log(`  ${c(C.cyan, 'Prób:')}          ${fmtNum(count)}`);
                    console.log(`  ${c(C.cyan, 'Czas:')}          ${fmtTime(elapsed)}`);
                    console.log(`  ${c(C.cyan, 'Hashrate:')}      ${fmtHashrate(rate)}`);
                    console.log(c(C.gray, '═'.repeat(60)));

                    // ── Submit block ─────────────────────────────────────────────
                    if (!opts.testMode) {
                        // #8 FIX: submit używa templateBlobBuf (z aktualnym extra_nonce)
                        const submitBuf = Buffer.from(templateBlobBuf);
                        submitBuf.writeUInt32LE(nonce, 39);
                        const submitHex = submitBuf.toString('hex');
                        console.log(`\n  ${c(C.cyan, 'Wysyłam blok do sieci...')}`);
                        try {
                            const result = await submitBlock(node, submitHex);
                            if (result && result.status === 'OK') {
                                totalBlocks++;
                                console.log(c(C.green + C.bold, `\n  ✅ BLOK ZAAKCEPTOWANY! Nagroda: 0.6 XMR`));
                                console.log(`  ${c(C.cyan, 'Łącznie znalezionych bloków:')} ${totalBlocks}`);
                                engine.reward(nonce);
                                engine.printStatus();
                            } else {
                                console.log(c(C.red, `\n  ❌ Blok odrzucony: ${JSON.stringify(result)}`));
                            }
                        } catch (e) {
                            console.log(c(C.red, `\n  ❌ Błąd submit: ${e.message}`));
                        }
                    } else {
                        const submitBuf = Buffer.from(templateBlobBuf);
                        submitBuf.writeUInt32LE(nonce, 39);
                        console.log(c(C.green, '\n  [TEST] Blok zostałby wysłany do sieci!'));
                        console.log(`  ${c(C.cyan, 'submit blob:')} ${submitBuf.toString('hex').slice(0, 32)}...`);
                        process.exit(0);
                    }
                    break;
                }

                // Raport postępu
                if (count % REPORT_EVERY === 0) {
                    const now = Date.now();
                    const elapsed = (now - lastReport) / 1000 || 0.001;
                    const rate = Math.round(REPORT_EVERY / elapsed);
                    const total = now - roundStart;
                    const bar = drawBar(nonce, MAX_NONCE, 20);
                    process.stdout.write(
                        `\r  ${bar} ` +
                        `block:${c(C.cyan, '#' + fmtNum(height))} ` +
                        `extra:${c(C.cyan, String(extraNonce))} ` +
                        `nonce:${c(C.white, fmtNum(nonce))} ` +
                        `rate:${c(C.orange, fmtHashrate(rate))} ` +
                        `time:${c(C.gray, fmtTime(total))}   `
                    );
                    lastReport = now;
                }

                // #5 FIX: dwie fazy iteracji
                if (phase === 'góra') {
                    nonce++;
                    if (nonce > MAX_NONCE) {
                        phase = 'dół';
                        nonce = 0;
                    }
                } else {
                    nonce++;
                    if (nonce >= startNonce) {
                        // Wyczerpano pełny zakres 32-bit → extra_nonce++
                        extraNonce++;
                        break;
                    }
                }
            } // koniec pętli nonce
        } // koniec pętli extra_nonce

        // #3 FIX: zapisz stan silnika osobno, nie nadpisuj modelu
        fs.writeFileSync(ENGINE_FILE, JSON.stringify(engine.exportState(), null, 2));
    }
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
    console.error(c(C.red, `\n❌ Błąd krytyczny: ${e.message}`), e.stack);
    process.exit(1);
});