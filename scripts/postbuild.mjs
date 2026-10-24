import { chmodSync, existsSync } from 'node:fs';

for (const f of ['dist/bin/mcp-terminal.js', 'dist/bin/termctl.js']) {
  if (existsSync(f)) chmodSync(f, 0o755);
}
