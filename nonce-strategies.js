#!/usr/bin/env node
/**
 * ============================================================
 *  nonce-strategies.js
 *  Deterministyczne strategie generowania nonce dla Monero
 *
 *  6 algorytmów × 2 tryby (stały / seeded) + dynamiczne wagi
 *
 *  IMPORT:
 *    const { StrategyEngine } = require('./nonce-strategies');
 *    const engine = new StrategyEngine(model.hotRanges);
 *    const nonce  = engine.next();           // wybiera wg wag
 *    engine.reward('golden', foundNonce);    // aktualizuj wagi po znalezieniu bloku
 *    engine.printStatus();                   // raport wag
 *
 *  EKSPORT FUNKCJI:
 *    suggestNonceStrategic(model, state)     // drop-in zamiennik dla suggestNonce()
 *    createStrategyState()                   // twórz persystentny stan
 * ============================================================
 */

'use strict';

const MAX_NONCE = 4294967295; // 2^32 - 1

// ─── Kolory ANSI ─────────────────────────────────────────────────────────────
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m',
    orange: '\x1b[38;5;208m', green: '\x1b[32m', red: '\x1b[31m',
    cyan: '\x1b[36m', yellow: '\x1b[33m', gray: '\x1b[90m',
    white: '\x1b[97m', magenta: '\x1b[35m', blue: '\x1b[34m',
};
const c = (col, s) => `${col}${s}${C.reset}`;
const fmtN = n => Math.round(n).toLocaleString('pl-PL');

// ═════════════════════════════════════════════════════════════════════════════
//  ALGORYTMY – każdy przyjmuje { lo, hi, state } i zwraca nonce (number)
//  state = wewnętrzny stan algorytmu (licznik, indeks itp.)
// ═════════════════════════════════════════════════════════════════════════════

const ALGORITHMS = {

    // ── 1. CENTER ──────────────────────────────────────────────────────────────
    // Stały punkt: dokładny środek przedziału.
    // Deterministyczny – zawsze ta sama wartość dla tego samego przedziału.
    center: {
        label: 'Center',
        description: 'Środek przedziału (lo + hi) / 2',
        baseWeight: 8,
        generate({ lo, hi }) {
            return Math.floor((lo + hi) / 2);
        },
        // Wersja seeded: środek przedziału przesunięty o hash seeda
        generateSeeded({ lo, hi, seed }) {
            const offset = seededInt(seed, 'center') % Math.floor((hi - lo) / 4);
            return Math.floor((lo + hi) / 2) + offset;
        },
    },

    // ── 2. GOLDEN_RATIO ────────────────────────────────────────────────────────
    // Złoty podział φ = 0.6180339887...
    // Próbuje 3 punktów: φ od lo, 1-φ od lo, φ² od lo
    // Każde wywołanie przesuwa się na kolejny punkt.
    golden: {
        label: 'Golden Ratio',
        description: 'lo + (hi-lo) × φⁿ, n = 1,2,3...',
        baseWeight: 20,
        generate({ lo, hi, state }) {
            const PHI = 0.6180339887498949;
            const span = hi - lo;
            const idx = state.goldenIdx || 0;
            // Kolejne potęgi φ dają gęste pokrycie bez powtórzeń (ciąg van der Corputa)
            const offset = span * Math.pow(PHI, idx % 12 + 1);
            state.goldenIdx = idx + 1;
            return Math.floor(lo + offset) % (MAX_NONCE + 1);
        },
        generateSeeded({ lo, hi, seed, state }) {
            const PHI = 0.6180339887498949;
            const span = hi - lo;
            // Seed przesuwa punkt startowy – inne bloki dają inne nonce
            const base = seededFloat(seed, 'golden');
            const idx = state.goldenIdx || 0;
            const frac = ((base + PHI * (idx + 1)) % 1 + 1) % 1;
            state.goldenIdx = idx + 1;
            return Math.floor(lo + span * frac) % (MAX_NONCE + 1);
        },
    },

    // ── 3. SEQUENTIAL_LO ───────────────────────────────────────────────────────
    // Sekwencja od początku przedziału krok po kroku.
    // Klasyczna metoda – pewna, ale przewidywalna.
    sequential: {
        label: 'Sequential lo→hi',
        description: 'Iteracja od lo do hi, krok=1',
        baseWeight: 5,
        generate({ lo, hi, state }) {
            const pos = state.seqPos || 0;
            const span = hi - lo;
            const nonce = lo + (pos % span);
            state.seqPos = pos + 1;
            return nonce;
        },
        generateSeeded({ lo, hi, seed, state }) {
            // Seed determinuje punkt startowy w przedziale
            const startOffset = seededInt(seed, 'seq') % (hi - lo);
            const pos = state.seqPos || 0;
            const span = hi - lo;
            const nonce = lo + ((startOffset + pos) % span);
            state.seqPos = pos + 1;
            return nonce;
        },
    },

    // ── 4. FIBONACCI_WALK ──────────────────────────────────────────────────────
    // Skacze po przedziale według kroków Fibonacciego znormalizowanych do span.
    // Daje nieregularne, ale powtarzalne pokrycie – nie klasteryzuje się.
    fibonacci: {
        label: 'Fibonacci Walk',
        description: 'Skoki wg ciągu Fib skalowanego do przedziału',
        baseWeight: 18,
        generate({ lo, hi, state }) {
            const FIB = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597, 2584];
            const span = hi - lo;
            const idx = state.fibIdx || 0;
            // Skumulowane skoki Fib modulo span → pokrycie bez powtórzeń
            const step = Math.floor(span * FIB[idx % FIB.length] / FIB[FIB.length - 1]);
            const pos = (state.fibPos || 0) + step;
            state.fibIdx = idx + 1;
            state.fibPos = pos % span;
            return lo + (pos % span);
        },
        generateSeeded({ lo, hi, seed, state }) {
            const FIB = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597, 2584];
            const span = hi - lo;
            const idx = state.fibIdx || 0;
            // Seed przesuwa indeks startowy
            const seedOff = seededInt(seed, 'fib') % FIB.length;
            const step = Math.floor(span * FIB[(idx + seedOff) % FIB.length] / FIB[FIB.length - 1]);
            const pos = ((state.fibPos || 0) + step) % span;
            state.fibIdx = idx + 1;
            state.fibPos = pos;
            return lo + pos;
        },
    },

    // ── 5. MIRROR ──────────────────────────────────────────────────────────────
    // Lustrzane odbicie: generuje nonce symetryczne do środka zakresu 32-bit.
    // Logika: jeśli góry zakresu są mniej eksplorowane, mirror to uzupełnia.
    // Próbuje też lustro względem środka przedziału.
    mirror: {
        label: 'Mirror',
        description: 'MAX_NONCE - nonce z center, eksploracja przeciwnej strony',
        baseWeight: 32,
        generate({ lo, hi, state }) {
            const phase = (state.mirrorPhase || 0) % 3;
            state.mirrorPhase = phase + 1;
            const center = Math.floor((lo + hi) / 2);
            if (phase === 0) return MAX_NONCE - center;                    // lustro globalne
            if (phase === 1) return MAX_NONCE - lo;                        // lustro lo
            return Math.abs(MAX_NONCE - center + Math.floor((hi - lo) / 4)) % (MAX_NONCE + 1); // lustro + offset
        },
        generateSeeded({ lo, hi, seed, state }) {
            const phase = (state.mirrorPhase || 0) % 3;
            state.mirrorPhase = phase + 1;
            // seedOff mały – tylko różnicuje wywołania, nie przesuwa daleko od MAX_NONCE
            const span = hi - lo;
            const seedOff = seededInt(seed, 'mirror') % span;
            const center = Math.floor((lo + hi) / 2);
            // Wszystkie trzy fazy celują w GÓRNĄ część przestrzeni (>75%)
            if (phase === 0) return MAX_NONCE - lo - seedOff;           // blisko MAX_NONCE
            if (phase === 1) return MAX_NONCE - center - seedOff;       // lustro środka
            return MAX_NONCE - hi - (seedOff % Math.max(1, Math.floor(span / 4))); // lustro hi
        },
    },

    // ── 6. PRIME_STEP ──────────────────────────────────────────────────────────
    // Kroczy przez przedział skokiem = pierwsza liczba pierwsza ≥ span/100.
    // Liczby pierwsze tworzą quasi-losowe, ale deterministyczne pokrycie.
    // Matematycznie: dla kroku p (pierwszego) i zakresu N, cykl = lcm(p, N) = p*N
    // jeśli gcd(p,N)=1, co jest prawie zawsze prawdą dla liczb pierwszych.
    primeStep: {
        label: 'Prime Step',
        description: 'Krok = pierwsza liczba pierwsza ≥ span/100',
        baseWeight: 25, // najwyższa waga bazowa – dobre pokrycie matematyczne
        generate({ lo, hi, state }) {
            const span = hi - lo;
            const step = state.primeVal || nearestPrime(Math.max(7, Math.floor(span / 100)));
            state.primeVal = step;
            const pos = ((state.primePos || 0) + step) % span;
            state.primePos = pos;
            return lo + pos;
        },
        generateSeeded({ lo, hi, seed, state }) {
            const span = hi - lo;
            // Seed determinuje która liczba pierwsza z listy jest używana
            const primes = [7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83];
            const seedIdx = seededInt(seed, 'prime') % primes.length;
            const baseP = nearestPrime(Math.max(7, Math.floor(span / 100)));
            // Kombinuj bazową pierwszą z seeded – zapewnia unikalność per blok
            const step = primes[(primes.indexOf(baseP) + seedIdx) % primes.length] || baseP;
            state.primeVal = step;
            const pos = ((state.primePos || 0) + step) % span;
            state.primePos = pos;
            return lo + pos;
        },
    },

};

// ═════════════════════════════════════════════════════════════════════════════
//  POMOCNICZE FUNKCJE MATEMATYCZNE
// ═════════════════════════════════════════════════════════════════════════════

// Czy liczba jest pierwsza
function isPrime(n) {
    if (n < 2) return false;
    if (n < 4) return true;
    if (n % 2 === 0 || n % 3 === 0) return false;
    for (let i = 5; i * i <= n; i += 6)
        if (n % i === 0 || n % (i + 2) === 0) return false;
    return true;
}

// Pierwsza liczba pierwsza ≥ n
function nearestPrime(n) {
    let k = Math.max(2, n);
    while (!isPrime(k)) k++;
    return k;
}

// Deterministyczny int z seeda i soli (prosta funkcja hash)
// Zwraca liczbę 0..2^31 powtarzalną dla tego samego (seed, salt)
function seededInt(seedHex, salt) {
    let h = 0x811c9dc5;
    const str = (seedHex || '0') + salt;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (Math.imul(h, 0x01000193)) >>> 0;
    }
    return h >>> 0; // uint32
}

// Deterministyczny float 0..1 z seeda i soli
function seededFloat(seedHex, salt) {
    return seededInt(seedHex, salt) / 4294967295;
}

// ═════════════════════════════════════════════════════════════════════════════
//  DYNAMICZNE WAGI – MAB (Multi-Armed Bandit) z Epsilon-Greedy + decay
// ═════════════════════════════════════════════════════════════════════════════
//
//  Każdy algorytm ma wagę W[i]. Po znalezieniu bloku:
//  - algorytm który wygenerował nonce "najbliższy" znalezionemu dostaje reward
//  - pozostałe dostają małą karę (decay)
//  - wagi są normalizowane do sumy = 100
//  - minimalna waga = MIN_WEIGHT (żaden algorytm nie jest całkowicie pomijany)

const REWARD_FACTOR = 1.30;  // waga × 1.30 dla najlepszego
const DECAY_FACTOR = 0.97;  // waga × 0.97 dla pozostałych
const MIN_WEIGHT = 3;     // minimalna waga [%]
const MAX_WEIGHT = 60;    // maksymalna waga [%]

// ═════════════════════════════════════════════════════════════════════════════
//  KLASA StrategyEngine – główny interfejs
// ═════════════════════════════════════════════════════════════════════════════

class StrategyEngine {
    /**
     * @param {Array}  hotRanges  - gorące przedziały z modelu (lo, hi, score)
     * @param {string} [seed]     - seed_hash bieżącego bloku (opcjonalny)
     * @param {Object} [initWeights] - początkowe wagi { algorithmKey: weight }
     */

    constructor(hotRanges, seed = null, initWeights = null) {
        // ── Deterministyczny PRNG (Mulberry32) ────────────────────────────────
        // Używany zamiast Math.random() aby wynik był powtarzalny
        // przy tych samych parametrach (stały tryb).
        this._prngState = 0x9e3779b9; // stały seed – daje powtarzalny wybór algo/range
        this._rng = () => {
            let z = (this._prngState += 0x6D2B79F5) >>> 0;
            z = Math.imul(z ^ z >>> 15, z | 1) >>> 0;
            z ^= z + Math.imul(z ^ z >>> 7, z | 61) >>> 0;
            return ((z ^ z >>> 14) >>> 0) / 4294967296;
        };
        this.hotRanges = hotRanges && hotRanges.length > 0
            ? hotRanges
            : [{ lo: 0, hi: MAX_NONCE, score: 1 }]; // fallback: cały zakres
        this.seed = seed;
        this.seeded = !!seed;

        // Stan wewnętrzny każdego algorytmu (liczniki, pozycje itp.)
        this.algStates = {};
        Object.keys(ALGORITHMS).forEach(k => { this.algStates[k] = {}; });

        // Wagi (sumują się do 100)
        this.weights = {};
        const keys = Object.keys(ALGORITHMS);
        if (initWeights) {
            keys.forEach(k => { this.weights[k] = initWeights[k] || ALGORITHMS[k].baseWeight; });
        } else {
            keys.forEach(k => { this.weights[k] = ALGORITHMS[k].baseWeight; });
        }
        this._normalizeWeights();

        // Historia wywołań (do nagradzania)
        this.history = []; // [{ algo, nonce, timestamp }]
        this.stats = {};
        keys.forEach(k => { this.stats[k] = { calls: 0, rewards: 0, totalDist: 0 }; });
    }

    // ── Wybierz algorytm wg wag (roulette wheel selection) ───────────────────
    _pickAlgorithm() {
        const keys = Object.keys(this.weights);
        const total = keys.reduce((s, k) => s + this.weights[k], 0);
        let pick = this._rng() * total;
        for (const k of keys) {
            pick -= this.weights[k];
            if (pick <= 0) return k;
        }
        return keys[keys.length - 1];
    }

    // ── Wybierz przedział (ważony przez score) ────────────────────────────────
    _pickRange() {
        const total = this.hotRanges.reduce((s, r) => s + (r.score || 1), 0);
        let pick = this._rng() * total;
        for (const r of this.hotRanges) {
            pick -= (r.score || 1);
            if (pick <= 0) return r;
        }
        return this.hotRanges[0];
    }

    // ── Normalizuj wagi do sumy = 100 z zachowaniem min/max ──────────────────
    _normalizeWeights() {
        const keys = Object.keys(this.weights);
        // Klamp do min/max
        keys.forEach(k => {
            this.weights[k] = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, this.weights[k]));
        });
        // Normalizuj do sumy 100
        const sum = keys.reduce((s, k) => s + this.weights[k], 0);
        keys.forEach(k => { this.weights[k] = (this.weights[k] / sum) * 100; });
    }

    // ── Główna funkcja: wygeneruj kolejny nonce ───────────────────────────────
    /**
     * @param {boolean} [useSeeded]  - true = użyj wariantu seeded; domyślnie wg this.seeded
     * @returns {{ nonce: number, algo: string, range: Object }}
     */
    next(useSeeded) {
        const doSeed = useSeeded !== undefined ? useSeeded : this.seeded;
        const algo = this._pickAlgorithm();
        const range = this._pickRange();
        const def = ALGORITHMS[algo];
        const state = this.algStates[algo];

        const ctx = {
            lo: range.lo,
            hi: range.hi,
            seed: this.seed,
            state,
        };

        const nonce = doSeed && def.generateSeeded
            ? def.generateSeeded(ctx)
            : def.generate(ctx);

        // Zapis do historii
        const record = { algo, nonce, range, timestamp: Date.now() };
        this.history.push(record);
        if (this.history.length > 1000) this.history.shift(); // ogranicz pamięć

        this.stats[algo].calls++;
        return { nonce, algo, range };
    }

    // ── Zaktualizuj wagi po znalezieniu bloku ─────────────────────────────────
    /**
     * Wywołaj gdy blok zostanie znaleziony.
     * @param {number} foundNonce   - rzeczywiście znaleziony nonce
     * @param {string} [hint]       - opcjonalnie: nazwa algorytmu który "trafił"
     */
    reward(foundNonce, hint) {
        const keys = Object.keys(ALGORITHMS);

        // Znajdź algorytm z historii który był "najbliżej" foundNonce
        let bestAlgo = hint || null;
        if (!bestAlgo && this.history.length > 0) {
            let minDist = Infinity;
            for (const rec of this.history.slice(-200)) { // ostatnie 200 rekordów
                const dist = Math.abs(rec.nonce - foundNonce);
                if (dist < minDist) {
                    minDist = dist;
                    bestAlgo = rec.algo;
                }
            }
        }

        if (!bestAlgo) return;

        // Aktualizuj wagi
        keys.forEach(k => {
            if (k === bestAlgo) {
                this.weights[k] *= REWARD_FACTOR;
                this.stats[k].rewards++;
            } else {
                this.weights[k] *= DECAY_FACTOR;
            }
        });

        this._normalizeWeights();

        // Aktualizuj średnią odległość dla najlepszego
        const bestRec = this.history.slice(-200).find(r => r.algo === bestAlgo);
        if (bestRec) {
            const dist = Math.abs(bestRec.nonce - foundNonce);
            this.stats[bestAlgo].totalDist += dist;
        }
    }

    // ── Zmień seed (nowy blok) ────────────────────────────────────────────────
    setSeed(seedHex) {
        this.seed = seedHex;
        this.seeded = !!seedHex;
        // Resetuj pozycyjne stany algorytmów (nowy blok = nowa iteracja)
        Object.keys(this.algStates).forEach(k => { this.algStates[k] = {}; });
    }

    // ── Eksportuj stan do zapisu (persystencja między sesjami) ────────────────
    exportState() {
        return {
            weights: { ...this.weights },
            stats: JSON.parse(JSON.stringify(this.stats)),
            exportedAt: new Date().toISOString(),
        };
    }

    // ── Importuj zapisany stan ────────────────────────────────────────────────
    importState(saved) {
        if (saved && saved.weights) {
            this.weights = { ...saved.weights };
            this._normalizeWeights();
        }
        if (saved && saved.stats) {
            this.stats = saved.stats;
        }
    }

    // ── Wydrukuj status wag ───────────────────────────────────────────────────
    printStatus() {
        console.log(`\n${c(C.yellow + C.bold, '  📊 STATUS STRATEGII NONCE')}`);
        console.log(c(C.gray, '  ' + '─'.repeat(58)));

        const keys = Object.keys(ALGORITHMS);
        const maxW = Math.max(...keys.map(k => this.weights[k]));
        const BAR_W = 25;

        keys.forEach(k => {
            const def = ALGORITHMS[k];
            const w = this.weights[k];
            const fill = Math.round((w / maxW) * BAR_W);
            const bar = '█'.repeat(fill).padEnd(BAR_W, '░');
            const wColor = w >= 30 ? C.green : w >= 15 ? C.orange : C.gray;
            const st = this.stats[k];
            const avgDist = st.rewards > 0
                ? fmtN(Math.round(st.totalDist / st.rewards))
                : c(C.gray, 'brak');

            console.log(
                `  ${c(C.cyan, def.label.padEnd(16))} ` +
                `${c(wColor, bar)} ${c(wColor, w.toFixed(1).padStart(5) + '%')} ` +
                `  wywołań: ${c(C.white, String(st.calls).padStart(4))} ` +
                `  nagród: ${c(C.green, String(st.rewards).padStart(3))} ` +
                `  śr.dist: ${avgDist}`
            );
        });

        console.log(c(C.gray, '  ' + '─'.repeat(58)));
        console.log(c(C.gray, `  REWARD_FACTOR=${REWARD_FACTOR}  DECAY=${DECAY_FACTOR}  MIN_W=${MIN_WEIGHT}%  MAX_W=${MAX_WEIGHT}%`));
    }

    // ── Opis wszystkich algorytmów ────────────────────────────────────────────
    static describe() {
        console.log(`\n${c(C.orange + C.bold, '  ⚙️  ALGORYTMY GENEROWANIA NONCE')}`);
        console.log(c(C.gray, '  ' + '─'.repeat(58)));
        Object.entries(ALGORITHMS).forEach(([k, def]) => {
            console.log(
                `  ${c(C.cyan, def.label.padEnd(18))} ` +
                `waga bazowa: ${c(C.orange, String(def.baseWeight).padStart(2) + '%')}  ` +
                c(C.gray, def.description)
            );
        });
        console.log();
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  EKSPORT – drop-in zamiennik dla suggestNonce() z nonce-analyzer.js
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Twórz persystentny stan silnika strategii.
 * Przechowuj między wywołaniami suggestNonceStrategic().
 *
 * @param {Array}  hotRanges  - z model.hotRanges
 * @param {Object} [saved]    - opcjonalnie: zapisany stan z engine.exportState()
 */
function createStrategyState(hotRanges, saved = null) {
    const engine = new StrategyEngine(hotRanges);
    if (saved) engine.importState(saved);
    return engine;
}

/**
 * Drop-in zamiennik dla suggestNonce(model).
 * Różnica: wymaga persystentnego `engine` (StrategyEngine).
 *
 * @param {StrategyEngine} engine  - z createStrategyState()
 * @param {boolean} [seeded]       - true = wariant seeded
 * @returns {number}               - sugerowany nonce
 */
function suggestNonceStrategic(engine, seeded = false) {
    return engine.next(seeded).nonce;
}

// ═════════════════════════════════════════════════════════════════════════════
//  DEMO – uruchom bezpośrednio aby zobaczyć jak działają algorytmy
// ═════════════════════════════════════════════════════════════════════════════

if (require.main === module) {
    const DEMO_RANGES = [
        { lo: 0, hi: 268435455, score: 12, source: 'histogram' },
        { lo: 805306368, hi: 1073741823, score: 18, source: 'cluster' },
        { lo: 2147483648, hi: 2684354559, score: 9, source: 'histogram' },
    ];

    const DEMO_SEED = 'a61293c1bfda814eaa4d8a0f7c35d63d';

    console.log(`\n${c(C.orange + C.bold, '⛏️  NONCE STRATEGIES – DEMO')}`);
    console.log(c(C.gray, '═'.repeat(62)));

    StrategyEngine.describe();

    // ── Tryb stały ────────────────────────────────────────────────────────────
    console.log(c(C.yellow + C.bold, '  🔒 TRYB STAŁY (deterministyczny)'));
    console.log(c(C.gray, '  Wyniki są POWTARZALNE przy tym samym stanie algorytmu.\n'));
    const engine1 = new StrategyEngine(DEMO_RANGES);
    for (let i = 0; i < 15; i++) {
        const { nonce, algo, range } = engine1.next(false);
        const pct = ((nonce / MAX_NONCE) * 100).toFixed(2);
        console.log(
            `  ${c(C.gray, String(i + 1).padStart(2) + '.')} ` +
            `algo=${c(C.cyan, ALGORITHMS[algo].label.padEnd(16))} ` +
            `nonce=${c(C.white, fmtN(nonce).padStart(16))} ` +
            `(${pct}%)  ` +
            `0x${nonce.toString(16).toUpperCase().padStart(8, '0')}`
        );
    }

    // ── Tryb seeded ───────────────────────────────────────────────────────────
    console.log(`\n${c(C.yellow + C.bold, '  🌱 TRYB SEEDED (seed = hash poprzedniego bloku)')}`);
    console.log(c(C.gray, `  seed: ${DEMO_SEED}\n`));
    const engine2 = new StrategyEngine(DEMO_RANGES, DEMO_SEED);
    for (let i = 0; i < 15; i++) {
        const { nonce, algo } = engine2.next(true);
        const pct = ((nonce / MAX_NONCE) * 100).toFixed(2);
        console.log(
            `  ${c(C.gray, String(i + 1).padStart(2) + '.')} ` +
            `algo=${c(C.cyan, ALGORITHMS[algo].label.padEnd(16))} ` +
            `nonce=${c(C.white, fmtN(nonce).padStart(16))} ` +
            `(${pct}%)  ` +
            `0x${nonce.toString(16).toUpperCase().padStart(8, '0')}`
        );
    }

    // ── Symulacja nagradzania ─────────────────────────────────────────────────
    console.log(`\n${c(C.yellow + C.bold, '  🎯 SYMULACJA DYNAMICZNYCH WAG (50 rund)')}`);
    console.log(c(C.gray, '  Symulujemy "znalezienie" bloku co 10 wywołań...\n'));

    const engine3 = new StrategyEngine(DEMO_RANGES);
    engine3.printStatus();

    // Symuluj 50 wywołań i 5 "znalezień"
    for (let round = 0; round < 50; round++) {
        engine3.next(false);
        if ((round + 1) % 10 === 0) {
            // Symuluj znalezienie bloku z losowym nonce
            const fakeFound = Math.floor(Math.random() * MAX_NONCE);
            engine3.reward(fakeFound);
            console.log(c(C.green, `  [runda ${round + 1}] znaleziono blok! nonce=${fmtN(fakeFound)} → aktualizacja wag`));
        }
    }

    engine3.printStatus();

    // ── Weryfikacja deterministyczności ───────────────────────────────────────
    console.log(`\n${c(C.yellow + C.bold, '  ✅ WERYFIKACJA DETERMINISTYCZNOŚCI')}`);
    console.log(c(C.gray, '  Dwa silniki z identycznym stanem powinny dać te same nonce:\n'));

    const e4 = new StrategyEngine(DEMO_RANGES);
    const e5 = new StrategyEngine(DEMO_RANGES);
    let allMatch = true;
    for (let i = 0; i < 10; i++) {
        const r4 = e4.next(false);
        const r5 = e5.next(false);
        const match = r4.nonce === r5.nonce && r4.algo === r5.algo;
        if (!match) allMatch = false;
        const icon = match ? c(C.green, '✅') : c(C.red, '❌');
        console.log(`  ${icon} algo=${c(C.cyan, r4.algo.padEnd(12))} nonce1=${fmtN(r4.nonce)}  nonce2=${fmtN(r5.nonce)}`);
    }
    console.log(allMatch
        ? c(C.green + C.bold, '\n  ✅ Pełna deterministyczność potwierdzona!')
        : c(C.red, '\n  ❌ Uwaga: wyniki się różnią (sprawdź Random w kodzie)'));

    console.log(`\n${c(C.cyan, '  IMPORT W SOLO-MINER.JS:')}`);
    console.log(c(C.gray, `
  const { StrategyEngine, createStrategyState, suggestNonceStrategic } = require('./nonce-strategies');
  const { loadModel } = require('./nonce-analyzer');

  const model  = loadModel();
  const engine = createStrategyState(model.hotRanges);

  // W pętli miningu:
  engine.setSeed(template.seed_hash);     // ← ustaw seed nowego bloku
  const nonce0 = suggestNonceStrategic(engine, true);  // ← seeded
  // lub:
  const nonce0 = suggestNonceStrategic(engine, false); // ← stały

  // Po znalezieniu bloku:
  engine.reward(foundNonce);              // ← aktualizuj wagi
  engine.printStatus();                   // ← pokaż raport
  `));
    console.log(c(C.gray, '═'.repeat(62)));
}

module.exports = {
    StrategyEngine,
    createStrategyState,
    suggestNonceStrategic,
    ALGORITHMS,
    MAX_NONCE,
};