// Loads selected pure calculation functions out of the shipped app.js and
// evaluates them in an isolated vm context, so tests exercise the REAL code
// without refactoring app.js into modules (app.js is one big browser IIFE).
//
// Usage:
//   const ctx = loadApp(['periodBounds', ...], { PSTART: 1, state: {...} });
//   ctx.periodBounds(0)
// Anything passed in `globals` becomes a global the functions can see; tests
// can reassign it later (ctx.state = {...}). A requested function that is not
// found in app.js throws, so a rename/removal fails loudly instead of
// silently skipping tests.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const APP_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app.js');
const SOURCE = readFileSync(APP_PATH, 'utf8');

// Returns the full text of `function name(...) { ... }` by matching braces,
// skipping strings, template literals, comments and regex-free brace noise.
export function extractFunction(name, src = SOURCE) {
  const re = new RegExp('(^|\\n)[ \\t]*function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) throw new Error('Function not found in app.js: ' + name);
  const start = m.index + m[1].length;
  let i = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('Unbalanced braces extracting ' + name);
}

export function loadApp(fnNames, globals = {}) {
  const ctx = vm.createContext({ ...globals, console });
  const code = fnNames.map((n) => extractFunction(n)).join('\n\n');
  vm.runInContext(code, ctx, { filename: 'app.js(extracted)' });
  return ctx;
}
