/**
 * Cross-engine check: CP-SAT must never score BELOW the greedy mock.
 *
 * CP-SAT is provably optimal for this model, so on identical input it can only
 * tie or beat a hill-climbing heuristic. If it ever scores lower, the two
 * engines are not solving the same problem -- a contract drift, a missing
 * constraint, or a mistranslated weight -- and this is how we find out.
 *
 * Run solver/tests/test_scheduler.py first; it writes .cpsat-scores.json.
 *
 *   node --experimental-strip-types solver/tests/compare-engines.mjs
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

register(
  `data:text/javascript,
   const SRC = ${JSON.stringify(join(ROOT, 'src').replace(/\\\\/g, '/'))};
   export function resolve(spec, ctx, next) {
     if (spec.startsWith('@/')) {
       let p = 'file:///' + SRC + '/' + spec.slice(2);
       if (!p.endsWith('.ts') && !p.endsWith('.js')) p += '.ts';
       return next(p, ctx);
     }
     return next(spec, ctx);
   }`,
  import.meta.url,
);

const { mockSolve } = await import('@/lib/mockSolver.ts');
const { solverInputSchema } = await import('@/lib/solverContract.ts');

const scoresPath = join(HERE, '.cpsat-scores.json');
if (!existsSync(scoresPath)) {
  console.error('\nRun solver/tests/test_scheduler.py first to produce .cpsat-scores.json\n');
  process.exit(1);
}
const cpsat = JSON.parse(await readFile(scoresPath, 'utf8'));

console.log('\n\x1b[1mEngine comparison -- CP-SAT vs greedy mock\x1b[0m\n');
console.log('fixture                          mock      CP-SAT    verdict');
console.log('-------------------------------- --------- --------- -------');

let failures = 0;
const files = (await readdir(join(HERE, 'fixtures'))).filter((f) => f.endsWith('.json')).sort();

for (const file of files) {
  const raw = JSON.parse(await readFile(join(HERE, 'fixtures', file), 'utf8'));
  const input = solverInputSchema.parse(raw);
  const mock = mockSolve(input).objective_value;
  const real = cpsat[file];

  if (real === undefined) {
    console.log(`${file.padEnd(32)} ${String(mock).padStart(9)} ${'?'.padStart(9)}  no CP-SAT score`);
    failures++;
    continue;
  }

  const verdict = real > mock ? 'CP-SAT better' : real === mock ? 'tie' : 'REGRESSION';
  if (real < mock) failures++;
  const colour = real < mock ? '\x1b[31m' : real > mock ? '\x1b[32m' : '';
  console.log(
    `${file.padEnd(32)} ${String(mock).padStart(9)} ${String(real).padStart(9)}  ${colour}${verdict}\x1b[0m`,
  );
}

console.log(
  failures === 0
    ? '\n\x1b[32mCP-SAT matches or beats the mock on every fixture.\x1b[0m\n'
    : `\n\x1b[31m${failures} fixture(s) where CP-SAT underperformed -- the engines disagree.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
