'use strict';
/**
 * strategy-debug.js
 *
 * CEL: testowanie czy silnik podpowiada sensowne nonce.
 * Pokazuje co engine sugeruje w kolejnych wywołaniach,
 * i co by się stało po wyczerpaniu nonce 32-bit (extra_nonce).
 *
 * NIE hashuje, NIE minuje – tylko loguje sugestie silnika.
 */

const fs = require('fs');
const { loadModel } = require('./nonce-analyzer');
const { createStrategyState, suggestNonceStrategic } = require('./nonce-strategies');
const { c, C, out } = require('./cli-util');
const { rpcCall, findWorkingNode, PUBLIC_NODES } = require('./nodes-api');
const { applyExtraNonce, rebuildHashBlob } = require('./merkle-util');

const MAX_NONCE = 0xFFFFFFFF;
const MODEL_FILE = 'model-state-test.json';
const ENGINE_FILE = 'engine-state.json';
const XMR_ADDRESS = '43H4noDNRRxA6BAzq6uaHj2WRcTLyM4av2Lz1y9BtrT9iVip1s65hsscfU1HxNn8kG6o89f5Y7fokPQHQN3qgMbn6gZK2Rf';
const ROUNDS = 10; // ile podpowiedzi pokazać

function getBlockTemplate(node, address) {
    return rpcCall(node, 'get_block_template', { wallet_address: address, reserve_size: 8 });
}

async function main() {
    console.log(`\n${c(C.orange, '⛏️  STRATEGY DEBUG — test podpowiedzi nonce')}`);
    console.log(c(C.gray, '═'.repeat(60)));

    // ── Model i silnik ────────────────────────────────────────────────────────
    const model = loadModel(MODEL_FILE);
    if (!model) {
        console.error(c(C.red, `❌ Brak ${MODEL_FILE}. Uruchom: node nonce-analyzer.js`));
        process.exit(1);
    }
    const engine = createStrategyState(model.hotRanges);
    if (fs.existsSync(ENGINE_FILE)) {
        try {
            engine.importState(JSON.parse(fs.readFileSync(ENGINE_FILE, 'utf8')));
            console.log(c(C.green, `  ✅ Wczytano stan silnika z ${ENGINE_FILE}`));
        } catch (_) {
            console.log(c(C.yellow, '  ⚠️  Błąd wczytywania stanu, startujemy od nowa'));
        }
    }

    // ── Węzeł i template ──────────────────────────────────────────────────────
    const node = await findWorkingNode(PUBLIC_NODES);
    if (!node) { console.error(c(C.red, '❌ Brak węzła')); process.exit(1); }

    const template = await getBlockTemplate(node, XMR_ADDRESS);
    const { blockhashing_blob, blocktemplate_blob, seed_hash, difficulty, height, reserved_offset } = template;

    console.log(c(C.gray, '\n  ' + '─'.repeat(58)));
    console.log(`  ${c(C.cyan, 'Blok #:')}          ${height}`);
    console.log(`  ${c(C.cyan, 'Difficulty:')}      ${Number(difficulty).toLocaleString('pl-PL')}`);
    console.log(`  ${c(C.cyan, 'reserved_offset:')} ${reserved_offset}`);
    console.log(`  ${c(C.cyan, 'seed_hash:')}       ${seed_hash.slice(0, 24)}...`);
    console.log(c(C.gray, '  ' + '─'.repeat(58)));

    engine.setSeed(seed_hash);

    // ── Runda 1: normalne podpowiedzi ─────────────────────────────────────────
    console.log(`\n${c(C.yellow, '  📍 PODPOWIEDZI SILNIKA (10 kolejnych wywołań):')}`);
    console.log(c(C.gray, '  ' + '─'.repeat(58)));

    for (let i = 0; i < ROUNDS; i++) {
        const { nonce, algo, range } = engine.next(true);
        const pct = (nonce / MAX_NONCE * 100).toFixed(2);
        console.log(
            `  ${c(C.gray, String(i + 1).padStart(2) + '.')} ` +
            `nonce: ${c(C.white, nonce.toLocaleString('pl-PL').padStart(14))} ` +
            `(${c(C.cyan, pct.padStart(6) + '%')}) ` +
            `0x${nonce.toString(16).toUpperCase().padStart(8, '0')} ` +
            `algo: ${c(C.orange, algo.padEnd(12))} ` +
            `range: ${c(C.gray, (range.lo / 1e9).toFixed(2) + 'G–' + (range.hi / 1e9).toFixed(2) + 'G')}`
        );
    }

    // ── Runda 2: symulacja wyczerpania nonce → extra_nonce ────────────────────
    console.log(`\n${c(C.yellow, '  🔄 SYMULACJA: wyczerpano nonce 32-bit → extra_nonce++')}`);
    console.log(c(C.gray, '  ' + '─'.repeat(58)));

    let templateBlobBuf = Buffer.from(blocktemplate_blob, 'hex');
    let hashBlobBuf = Buffer.from(blockhashing_blob, 'hex');

    for (let extraNonce = 1; extraNonce <= 3; extraNonce++) {
        // Zastosuj extra_nonce lokalnie (bez round-trip do węzła)
        templateBlobBuf = applyExtraNonce(templateBlobBuf, reserved_offset, extraNonce);
        hashBlobBuf = rebuildHashBlob(templateBlobBuf, hashBlobBuf);

        // Nowy seed_hash się nie zmienił – ale algStates resetujemy ręcznie
        // żeby silnik sugerował nonce od nowa dla nowego hashBlob
        engine.setSeed(seed_hash);

        const { nonce, algo } = engine.next(true);
        const pct = (nonce / MAX_NONCE * 100).toFixed(2);
        const merkleInHash = hashBlobBuf.slice(43, 75).toString('hex').slice(0, 16);

        console.log(
            `  extra_nonce=${c(C.cyan, String(extraNonce))}  ` +
            `nonce: ${c(C.white, nonce.toLocaleString('pl-PL').padStart(14))} ` +
            `(${c(C.cyan, pct.padStart(6) + '%')}) ` +
            `algo: ${c(C.orange, algo.padEnd(12))} ` +
            `merkle: ${c(C.gray, merkleInHash + '...')}`
        );
    }

    // ── Status silnika ────────────────────────────────────────────────────────
    engine.printStatus();

    // ── Zapis stanu ───────────────────────────────────────────────────────────
    fs.writeFileSync(ENGINE_FILE, JSON.stringify(engine.exportState(), null, 2));
    console.log(c(C.green, `\n  ✅ Stan silnika zapisany → ${ENGINE_FILE}`));
    console.log(c(C.gray, '═'.repeat(60) + '\n'));
}

main().catch(e => {
    console.error(c(C.red, `\n❌ Błąd: ${e.message}`));
    console.error(e.stack);
    process.exit(1);
});