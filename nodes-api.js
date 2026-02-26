const https = require('https');
const http = require('http');
const os = require('os');

const { c, C } = require("./cli-util");


const PUBLIC_NODES = [
    'http://node.moneroworld.com:18089',
    'http://nodes.hashvault.pro:18081',
    'http://node.community.rino.io:18081',
    'http://opennode.xmr-tw.org:18089',
    'http://p2pmd.xmr-tw.org:18089',
];


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


module.exports = {
    PUBLIC_NODES,
    findWorkingNode,
    rpcCall,
};