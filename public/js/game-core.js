// Node-side shim for tests: the HTTP server serves /js/game-core.js directly
// from src/game-core.js, so browsers never load this file. It exists so that
// modules in public/js (e.g. bot.js) can also be imported by Node tests.
export * from '../../src/game-core.js';