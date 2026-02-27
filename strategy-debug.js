const { loadModel } = require("./nonce-analyzer");
const { createStrategyState, suggestNonceStrategic } = require("./nonce-strategies");
const { c, C, out } = require("./cli-util");
const { rpcCall, findWorkingNode, PUBLIC_NODES } = require('./nodes-api');

async function getBlockTemplate(node, address) {
    return await rpcCall(node, 'get_block_template', {
        wallet_address: address,
        reserve_size: 8,
    });
}

async function loop() {

    const address = "43H4noDNRRxA6BAzq6uaHj2WRcTLyM4av2Lz1y9BtrT9iVip1s65hsscfU1HxNn8kG6o89f5Y7fokPQHQN3qgMbn6gZK2Rf";
    const model = loadModel('model-state-test.json');
    const engine = createStrategyState(model.hotRanges, model);

    const node = await findWorkingNode(PUBLIC_NODES);
    let template = await getBlockTemplate(node, address);

    engine.setSeed(template.seed_hash);
    let nonce = suggestNonceStrategic(engine, true);


    for (let i = 0; i < 10; i++) {


        out(`nonce: ${c(C.gray, nonce)} \n`);

        //engine.reward(nonce);
        //engine.printStatus();

        engine.setSeed(template.seed_hash);
        nonce = suggestNonceStrategic(engine);

        template = await getBlockTemplate(node, address);

        const saved = engine.exportState();
        fs.writeFileSync('model-state-test.json', JSON.stringify(saved));

    }


}

loop();