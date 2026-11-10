#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { type IO, run } from './cli.js';

const isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true;
const io: IO = {
  cwd: process.cwd(),
  env: process.env,
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  isTTY,
};
if (isTTY) {
  io.ask = async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}

run(process.argv.slice(2), io).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`Erreur interne : ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  },
);
