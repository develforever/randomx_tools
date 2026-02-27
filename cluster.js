const cluster = require('node:cluster');

const numCPUs = require('node:os').availableParallelism();

cluster.setupPrimary({
    exec: 'index.js',
    args: process.argv.slice(2),
});

if (cluster.isPrimary) {
    console.log(`Master ${process.pid} uruchomiony`);
    console.log(`Liczba rdzeni: ${numCPUs}`);

    const waorkersCount = numCPUs > 10 ? 6 : 2;
    // Tworzenie workerów
    for (let i = 0; i < waorkersCount; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker) => {
        console.log(`Worker ${worker.process.pid} zakończył pracę. Odpalam nowy...`);
        // cluster.fork();
    });
} else {

    const args = process.argv.slice(2);

    // Logujemy informację z konkretnego procesu
    console.log(`[WORKER ${process.pid}] Otrzymałem parametry:`, args);

    console.log(`Worker ${process.pid} wystartował`);

    process.exit(0);
}