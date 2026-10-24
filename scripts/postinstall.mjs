// Fixes a packaging defect in node-pty 1.1.0: the prebuilt `spawn-helper`
// binary is shipped without the executable bit, which makes every spawn fail
// with "posix_spawnp failed". Safe to run repeatedly. The server repeats this
// check at runtime (src/util/node-pty-fix.ts).
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
let root;
try {
  root = dirname(require.resolve('node-pty/package.json'));
} catch {
  process.exit(0);
}
const fixed = [];
for (const sub of ['prebuilds', 'build/Release']) {
  const base = join(root, sub);
  if (!existsSync(base)) continue;
  const dirs = sub === 'prebuilds' ? readdirSync(base).map((d) => join(base, d)) : [base];
  for (const dir of dirs) {
    const helper = join(dir, 'spawn-helper');
    if (!existsSync(helper)) continue;
    const mode = statSync(helper).mode;
    if ((mode & 0o111) !== 0o111) {
      chmodSync(helper, mode | 0o755);
      fixed.push(helper);
    }
  }
}
if (fixed.length) console.error(`[mcp-terminal] made node-pty spawn-helper executable: ${fixed.join(', ')}`);
