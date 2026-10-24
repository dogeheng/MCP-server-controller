import { execFile } from 'node:child_process';

export type DialogResult = 'allow_once' | 'allow_always' | 'deny' | 'timeout' | 'unavailable';

const SCRIPT = [
  'on run argv',
  'set msg to item 1 of argv',
  'set secs to (item 2 of argv) as integer',
  'try',
  'set r to display dialog msg with title "MCP Terminal · 命令审批" buttons {"拒绝", "总是允许", "允许一次"} default button "拒绝" cancel button "拒绝" giving up after secs with icon caution',
  'if gave up of r then return "timeout"',
  'return button returned of r',
  'on error number -128',
  'return "拒绝"',
  'end try',
  'end run',
];

/**
 * Shows a native approval dialog on the user's screen. The message is passed as
 * an argv item (never interpolated into AppleScript source), "拒绝" (deny) is the
 * default button, and the dialog gives up after `timeoutS` seconds.
 */
export function askWithDialog(message: string, timeoutS: number): Promise<DialogResult> {
  return new Promise((resolve) => {
    const args = SCRIPT.flatMap((l) => ['-e', l]);
    args.push(message.slice(0, 1800), String(timeoutS));
    execFile('/usr/bin/osascript', args, { timeout: (timeoutS + 10) * 1000 }, (err, stdout) => {
      if (err) return resolve('unavailable');
      const out = String(stdout).trim();
      if (out === '允许一次') resolve('allow_once');
      else if (out === '总是允许') resolve('allow_always');
      else if (out === 'timeout') resolve('timeout');
      else resolve('deny');
    });
  });
}
