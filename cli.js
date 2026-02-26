


const { c, C, drawBar, out } = require('./cli-util');

console.log(c(C.red, 'Hello World'));

let bar = drawBar(5, 20, 20);
out(bar);

setTimeout(() => {
    bar = drawBar(10, 20, 20);
    out(bar);
}, 1000);

setTimeout(() => {
    bar = drawBar(15, 20, 20);
    out(bar);
}, 2000);

setTimeout(() => {
    bar = drawBar(20, 20, 20);
    out(bar);
}, 3000);
