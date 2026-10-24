import { createRequire } from 'node:module';
import { Language, Parser, type Node } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

export interface SimpleCommand {
  argv: string[];
  nameDynamic: boolean;
  argsDynamic: boolean;
  text: string;
}

export interface ParseResult {
  commands: SimpleCommand[];
  pipelines: SimpleCommand[][];
  parseError: boolean;
}

let parser: Parser | undefined;
let initPromise: Promise<void> | undefined;

export function initParser(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await Parser.init();
      const lang = await Language.load(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'));
      const p = new Parser();
      p.setLanguage(lang);
      parser = p;
    })();
  }
  return initPromise;
}

export function parserReady() {
  return !!parser;
}

const DYNAMIC = new Set([
  'simple_expansion', 'expansion', 'command_substitution', 'process_substitution', 'arithmetic_expansion',
]);

function unescapeWord(s: string) {
  return s.replace(/\\(.)/gs, '$1');
}

function hasDynamic(n: Node): boolean {
  if (DYNAMIC.has(n.type)) return true;
  for (const c of n.namedChildren) if (c && hasDynamic(c)) return true;
  return false;
}

function wordValue(n: Node): { value: string; dynamic: boolean } {
  switch (n.type) {
    case 'word':
    case 'number':
      return { value: unescapeWord(n.text), dynamic: false };
    case 'raw_string':
      return { value: n.text.slice(1, -1), dynamic: false };
    case 'ansi_c_string':
      return { value: n.text.slice(2, -1), dynamic: false };
    case 'string':
      if (hasDynamic(n)) return { value: n.text, dynamic: true };
      return { value: n.text.slice(1, -1).replace(/\\(["\\$`])/g, '$1'), dynamic: false };
    case 'concatenation': {
      let value = '';
      let dynamic = false;
      for (const c of n.namedChildren) {
        if (!c) continue;
        const v = wordValue(c);
        value += v.value;
        dynamic ||= v.dynamic;
      }
      // Unnamed children (e.g. literal "=" or quotes) are not represented above.
      if (!n.namedChildren.length) value = n.text;
      return { value: dynamic ? n.text : value || n.text, dynamic };
    }
    case 'command_name': {
      const c = n.namedChildren[0];
      return c ? wordValue(c) : { value: n.text, dynamic: false };
    }
    default:
      return { value: n.text, dynamic: DYNAMIC.has(n.type) || hasDynamic(n) || n.type !== 'brace_expression' };
  }
}

function toSimple(n: Node): SimpleCommand | undefined {
  const nameNode = n.childForFieldName('name');
  if (!nameNode) return undefined;
  const name = wordValue(nameNode);
  const argv = [name.value];
  let argsDynamic = false;
  for (const a of n.childrenForFieldName('argument')) {
    if (!a) continue;
    const v = wordValue(a);
    argv.push(v.value);
    argsDynamic ||= v.dynamic;
  }
  return { argv, nameDynamic: name.dynamic, argsDynamic, text: n.text };
}

export function parseCommand(text: string): ParseResult {
  if (!parser) throw new Error('command parser not initialised');
  const tree = parser.parse(text);
  if (!tree) return { commands: [], pipelines: [], parseError: true };
  const commands: SimpleCommand[] = [];
  const pipelines: SimpleCommand[][] = [];
  const byNode = new Map<number, SimpleCommand>();
  const pipeNodes: Node[] = [];
  const stack: Node[] = [tree.rootNode];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'command') {
      const sc = toSimple(n);
      if (sc) {
        commands.push(sc);
        byNode.set(n.id, sc);
      }
    } else if (n.type === 'pipeline') pipeNodes.push(n);
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
  const firstCommand = (n: Node): SimpleCommand | undefined => {
    if (n.type === 'command') return byNode.get(n.id);
    for (const c of n.namedChildren) {
      if (!c) continue;
      const r = firstCommand(c);
      if (r) return r;
    }
    return undefined;
  };
  for (const p of pipeNodes) {
    const members = p.namedChildren.map((c) => (c ? firstCommand(c) : undefined)).filter((x): x is SimpleCommand => !!x);
    if (members.length > 1) pipelines.push(members);
  }
  const parseError = tree.rootNode.hasError;
  tree.delete();
  return { commands, pipelines, parseError };
}
