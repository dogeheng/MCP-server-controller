import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * node-pty 1.1.0 ships prebuilds/<platform>/spawn-helper without the executable
 * bit, which makes every spawn fail with "posix_spawnp failed". Returns the files fixed.
 */
export function fixNodePty(): string[] {
  let root: string;
  try {
    root = dirname(require.resolve('node-pty/package.json'));
  } catch {
    return [];
  }
  const fixed: string[] = [];
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
  return fixed;
}
