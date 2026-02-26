

const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    orange: '\x1b[38;5;208m', green: '\x1b[32m', red: '\x1b[31m',
    cyan: '\x1b[36m', yellow: '\x1b[33m', gray: '\x1b[90m',
    white: '\x1b[97m', magenta: '\x1b[35m',
};
const c = (color, s) => `${color}${s}${C.reset}`;

// ─── Pasek postępu ────────────────────────────────────────────────────────────
function drawBar(current, max, width) {
    const pct = Math.min(current / max, 1);
    const fill = Math.floor(pct * width);
    return `[${c(C.orange, '█'.repeat(fill))}${c(C.gray, '░'.repeat(width - fill))}]`;
}

function out(output) {
    process.stdout.write(
        `\r  ${output} \x1b[K`
    );
}

module.exports = {
    C,
    c,
    drawBar,
    out,
};