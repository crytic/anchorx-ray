#!/usr/bin/env node
// @solana/web3.js v1 pulls in node-fetch → whatwg-url → the deprecated `punycode`
// core module; silence that one import-time notice rather than show it on every run.
process.noDeprecation = true;
const { main } = await import("./main.js");
process.noDeprecation = false;

process.exitCode = await main(process.argv.slice(2));
