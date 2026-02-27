'use strict';
/**
 * merkle-util.js
 *
 * Narzędzia do lokalnego przeliczania hashBlob po zmianie extra_nonce.
 * Nie wymaga żadnych zewnętrznych zależności – czyste Node.js.
 *
 * EKSPORT:
 *   keccak256(buf)                          → Buffer 32B
 *   merkleRoot(txids)                       → Buffer 32B
 *   applyExtraNonce(templateBlob, reserved_offset, extraNonce) → Buffer
 *   rebuildHashBlob(templateBlob, reserved_offset, extraNonce, hashBlob) → Buffer
 *
 * UŻYCIE w strategy-debug.js / index.js:
 *   const { rebuildHashBlob } = require('./merkle-util');
 *
 *   // Po wyczerpaniu nonce 32-bit:
 *   extraNonce++;
 *   hashBlobBuf = rebuildHashBlob(templateBlob, template.reserved_offset, extraNonce, hashBlobBuf);
 *   nonce = suggestNonceStrategic(engine, true);
 */

// ═════════════════════════════════════════════════════════════════════════════
//  KECCAK-256  (Monero używa Keccak-256, nie SHA3-256 – różnią się paddingiem)
//  Zweryfikowano na oficjalnych test vectors:
//    keccak256('')    = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
//    keccak256('abc') = 4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45
// ═════════════════════════════════════════════════════════════════════════════

const _RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const _PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const _ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const _M64 = 0xFFFFFFFFFFFFFFFFn;
const _rot = (v, n) => ((v << BigInt(n)) | (v >> (64n - BigInt(n)))) & _M64;

function _keccakF(s) {
    for (let r = 0; r < 24; r++) {
        // θ
        const C = new Array(5);
        for (let i = 0; i < 5; i++) C[i] = s[i] ^ s[i + 5] ^ s[i + 10] ^ s[i + 15] ^ s[i + 20];
        for (let i = 0; i < 5; i++) {
            const t = C[(i + 4) % 5] ^ _rot(C[(i + 1) % 5], 1);
            for (let j = 0; j < 25; j += 5) s[j + i] ^= t;
        }
        // ρ + π
        let last = s[1];
        for (let i = 0; i < 24; i++) {
            const j = _PILN[i], t = s[j];
            s[j] = _rot(last, _ROTC[i]);
            last = t;
        }
        // χ
        for (let j = 0; j < 25; j += 5) {
            const t = s.slice(j, j + 5);
            for (let i = 0; i < 5; i++) s[j + i] = t[i] ^ (~t[(i + 1) % 5] & t[(i + 2) % 5]);
        }
        // ι
        s[0] ^= _RC[r];
    }
}

/**
 * Keccak-256 (używany w Monero jako CN fast hash dla pojedynczej wiadomości).
 * @param {Buffer|string} msg
 * @returns {Buffer} 32 bajty
 */
function keccak256(msg) {
    const RATE = 136; // (1600 - 256*2) / 8 bajtów
    const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
    const s = new Array(25).fill(0n);

    // Absorb pełnych bloków
    let offset = 0;
    while (offset + RATE <= buf.length) {
        for (let i = 0; i < RATE / 8; i++) s[i] ^= buf.readBigUInt64LE(offset + i * 8);
        _keccakF(s);
        offset += RATE;
    }

    // Ostatni blok + padding Keccak (0x01, nie 0x06 jak SHA3)
    const pad = Buffer.alloc(RATE, 0);
    buf.copy(pad, 0, offset);
    pad[buf.length - offset] = 0x01;
    pad[RATE - 1] |= 0x80;
    for (let i = 0; i < RATE / 8; i++) s[i] ^= pad.readBigUInt64LE(i * 8);
    _keccakF(s);

    // Squeeze 256 bitów
    const out = Buffer.alloc(32);
    for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], i * 8);
    return out;
}

// ═════════════════════════════════════════════════════════════════════════════
//  MERKLE ROOT  (algorytm Monero – różni się od Bitcoin!)
//
//  Monero nie dopełnia do potęgi 2 – używa prostszego algorytmu:
//    count=1 → merkle = txid[0]
//    count=2 → merkle = hash(txid[0] || txid[1])
//    count>2 → cnt = największa potęga 2 ≤ count
//              pierwsze 2*cnt - count par hashujemy,
//              reszta przechodzi bez zmian, potem standardowe drzewo
//  Źródło: src/crypto/tree-hash.c w repozytorium Monero
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Oblicz merkle root z listy txid (każdy Buffer 32B).
 * @param {Buffer[]} txids
 * @returns {Buffer} 32 bajty
 */
function merkleRoot(txids) {
    const count = txids.length;
    if (count === 0) return Buffer.alloc(32);
    if (count === 1) return Buffer.from(txids[0]);
    if (count === 2) return keccak256(Buffer.concat([txids[0], txids[1]]));

    // Znajdź największą potęgę 2 ≤ count
    let cnt = 1;
    while (cnt * 2 <= count) cnt *= 2;

    // Pierwsza runda: zhashuj nadmiarowe pary (count - cnt par)
    const hashes = txids.map(x => Buffer.from(x));
    const excess = count - cnt;
    for (let i = 0; i < excess; i++) {
        hashes[i] = keccak256(Buffer.concat([hashes[i * 2], hashes[i * 2 + 1]]));
    }
    // Skróć tablicę do cnt elementów
    const tree = [
        ...hashes.slice(0, excess),                    // zhashowane pary
        ...hashes.slice(excess * 2),                   // reszta bez zmian
    ];

    // Standardowe drzewo binarne
    let layer = tree;
    while (layer.length > 1) {
        const next = [];
        for (let i = 0; i < layer.length; i += 2) {
            if (i + 1 < layer.length) {
                next.push(keccak256(Buffer.concat([layer[i], layer[i + 1]])));
            } else {
                next.push(layer[i]);
            }
        }
        layer = next;
    }
    return layer[0];
}

// ═════════════════════════════════════════════════════════════════════════════
//  VARINT  (używany w parsowaniu blocktemplate_blob)
// ═════════════════════════════════════════════════════════════════════════════

function readVarint(buf, offset) {
    let result = 0n, shift = 0n, pos = offset;
    while (true) {
        const b = buf[pos++];
        result |= BigInt(b & 0x7F) << shift;
        if (!(b & 0x80)) break;
        shift += 7n;
    }
    return { value: Number(result), next: pos };
}

// ═════════════════════════════════════════════════════════════════════════════
//  PARSE BLOCKTEMPLATE_BLOB
//
//  Struktura blocktemplate_blob:
//    [header]
//      major_version  varint
//      minor_version  varint
//      timestamp      varint
//      prev_id        32 bajty
//      nonce          4 bajty LE   ← bajt 39 (dla typowego bloku v16)
//    [tx_count]       varint        ← liczba wszystkich tx (coinbase + reszta)
//    [coinbase_tx]    zmienna dł.   ← tutaj jest reserved_offset
//    [tx_hashes]      (tx_count-1) × 32 bajty
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Sparsuj blocktemplate_blob i zwróć pozycje kluczowych pól.
 * @param {Buffer} blob
 * @returns {{ headerEnd, txCount, coinbaseStart, coinbaseEnd, txHashesStart }}
 */
function parseTemplateBlob(blob) {
    let pos = 0;

    // Header: major, minor, timestamp (varints) + prev_id (32B) + nonce (4B)
    const v1 = readVarint(blob, pos); pos = v1.next;  // major_version
    const v2 = readVarint(blob, pos); pos = v2.next;  // minor_version
    const v3 = readVarint(blob, pos); pos = v3.next;  // timestamp
    pos += 32; // prev_id
    pos += 4;  // nonce
    const headerEnd = pos;

    // tx_count
    const txV = readVarint(blob, pos); pos = txV.next;
    const txCount = txV.value;

    const coinbaseStart = pos;

    // Parse coinbase_tx length:
    // Monero tx prefix: version (varint) + unlock_time (varint) + vin_count (varint) + ...
    // Najprościej: coinbase tx kończy się przed tx_hashes
    // tx_hashes = (txCount - 1) × 32 bajty od końca bloba
    const txHashesStart = blob.length - (txCount - 1) * 32;
    const coinbaseEnd = txHashesStart;

    return { headerEnd, txCount, coinbaseStart, coinbaseEnd, txHashesStart };
}

// ═════════════════════════════════════════════════════════════════════════════
//  APPLY EXTRA_NONCE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Zapisz extra_nonce (8B LE) w templateBlob pod reserved_offset.
 * Zwraca zmodyfikowany bufor (nowa kopia – oryginał niezmieniony).
 *
 * @param {Buffer} templateBlob
 * @param {number} reservedOffset  - z odpowiedzi get_block_template
 * @param {number} extraNonce      - licznik 0, 1, 2, ...
 * @returns {Buffer}
 */
function applyExtraNonce(templateBlob, reservedOffset, extraNonce) {
    const buf = Buffer.from(templateBlob); // kopia
    buf.writeBigUInt64LE(BigInt(extraNonce), reservedOffset);
    return buf;
}

// ═════════════════════════════════════════════════════════════════════════════
//  REBUILD HASHBLOB
//
//  Po zmianie extra_nonce w templateBlob:
//    1. Wyodrębnij coinbase_tx
//    2. Oblicz nowy txid = keccak256(coinbase_tx)
//    3. Wyodrębnij pozostałe txids z templateBlob
//    4. Oblicz nowy merkle_root([txid, tx2, tx3, ...])
//    5. Wstaw merkle_root do hashBlob na bajty 7..38
//       (blockhashing_blob: 7 = po major+minor+timestamp+prev_id zaczyna się od 7? NIE –
//        hashBlob ma tę samą strukturę nagłówka co templateBlob ale BEZ coinbase_tx/txids,
//        zamiast nich jest merkle_root na bajtach 7..38 relative do początku hashBlob)
//
//  Uwaga o offset merkle w hashBlob:
//    blockhashing_blob = [major(1B)] [minor(1B)] [timestamp(5B)] [prev_id(32B)] [nonce(4B)] [merkle(32B)]
//    merkle zaczyna się po: 1+1+5+32+4 = 43 → ale timestamp może mieć różną długość!
//    Bezpieczniej: sparsuj header hashBlob żeby znaleźć dokładny offset merkle.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Przebuduj blockhashing_blob (hashBlob) po zmianie extra_nonce.
 *
 * @param {Buffer} templateBlobWithExtraNonce - wynik applyExtraNonce()
 * @param {Buffer} currentHashBlob            - obecny blockhashing_blob (jako Buffer)
 * @returns {Buffer}                          - nowy hashBlob gotowy do iteracji nonce
 */
function rebuildHashBlob(templateBlobWithExtraNonce, currentHashBlob) {
    const blob = templateBlobWithExtraNonce;

    // 1. Sparsuj templateBlob
    const { coinbaseStart, coinbaseEnd, txHashesStart, txCount } = parseTemplateBlob(blob);

    // 2. Txid coinbase = keccak256(coinbase_tx)
    const coinbaseTx = blob.slice(coinbaseStart, coinbaseEnd);
    const coinbaseTxid = keccak256(coinbaseTx);

    // 3. Pozostałe txids z templateBlob
    const otherTxids = [];
    for (let i = 0; i < txCount - 1; i++) {
        otherTxids.push(blob.slice(txHashesStart + i * 32, txHashesStart + (i + 1) * 32));
    }

    // 4. Nowy merkle root
    const newMerkle = merkleRoot([coinbaseTxid, ...otherTxids]);

    // 5. Znajdź offset merkle w hashBlob
    //    hashBlob header: major(v) + minor(v) + timestamp(v) + prev_id(32B) + nonce(4B)
    //    merkle root zaczyna się zaraz po nonce = po headerEnd
    const hashBuf = Buffer.from(currentHashBlob);
    let pos = 0;
    const hv1 = readVarint(hashBuf, pos); pos = hv1.next;
    const hv2 = readVarint(hashBuf, pos); pos = hv2.next;
    const hv3 = readVarint(hashBuf, pos); pos = hv3.next;
    pos += 32; // prev_id
    pos += 4;  // nonce
    // pos = offset merkle root w hashBlob

    if (pos + 32 > hashBuf.length) {
        throw new Error(`rebuildHashBlob: hashBlob za krótki (${hashBuf.length}B, merkle offset=${pos})`);
    }

    newMerkle.copy(hashBuf, pos);
    return hashBuf;
}

// ═════════════════════════════════════════════════════════════════════════════
//  EKSPORT
// ═════════════════════════════════════════════════════════════════════════════

module.exports = {
    keccak256,
    merkleRoot,
    applyExtraNonce,
    rebuildHashBlob,
    parseTemplateBlob, // eksportowany do debugowania
};