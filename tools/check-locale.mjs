// Compare the zh and en dictionaries key by key, so a missing translation that
// renders as a raw key ("dialog.cancel") is caught rather than shipped.
//
// The dictionary bodies are sliced between their own braces: scanning the whole
// file would also match code outside the dictionaries (e.g. the apiJson helper's
// `? "timeout" : "network"` literals), producing phantom duplicates.
//
// Exits 1 on any key-parity problem, so it can run as a gate.
import { readFileSync } from 'node:fs';

const source = readFileSync('lib/client.js', 'utf8');

/** Body of a `const <name> = { ... };` dictionary literal. */
function dictionaryBody(name) {
  const start = source.indexOf(`const ${name} = {`);
  if (start === -1) throw new Error(`no \`const ${name}\` dictionary found`);
  const open = source.indexOf('{', start);
  const end = source.indexOf('\n    };', open);
  if (end === -1) throw new Error(`unterminated \`const ${name}\` dictionary`);
  return source.slice(open, end);
}

const zhBody = dictionaryBody('zh');
const enBody = dictionaryBody('en');
const keysOf = (text) => new Set([...text.matchAll(/"([a-zA-Z][\w.]*)"\s*:/g)].map((m) => m[1]));

const zh = keysOf(zhBody);
const en = keysOf(enBody);

const onlyZh = [...zh].filter((k) => !en.has(k)).sort();
const onlyEn = [...en].filter((k) => !zh.has(k)).sort();

console.log(`zh keys: ${zh.size}`);
console.log(`en keys: ${en.size}`);
console.log(`only in zh: ${onlyZh.length ? onlyZh.join(', ') : 'none'}`);
console.log(`only in en: ${onlyEn.length ? onlyEn.join(', ') : 'none'}`);

// Every key referenced by t("...") must exist in both dictionaries, otherwise
// the UI renders the literal key text.
const used = new Set([...source.matchAll(/\bt\("([^"]+)"\)/g)].map((m) => m[1]));
const missingZh = [...used].filter((k) => !zh.has(k)).sort();
const missingEn = [...used].filter((k) => !en.has(k)).sort();
console.log(`\nt() call sites: ${used.size}`);
console.log(`missing from zh: ${missingZh.length ? missingZh.join(', ') : 'none'}`);
console.log(`missing from en: ${missingEn.length ? missingEn.join(', ') : 'none'}`);

// Defined but never referenced is dead weight, not a failure.
const unused = [...zh].filter((k) => !used.has(k)).sort();
console.log(`defined but unused: ${unused.length ? unused.join(', ') : 'none'}`);

// Duplicate keys inside one dictionary silently drop the earlier value.
for (const [label, body] of [['zh', zhBody], ['en', enBody]]) {
  const seen = new Map();
  for (const m of body.matchAll(/"([a-zA-Z][\w.]*)"\s*:/g)) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${k}×${n}`);
  console.log(`duplicate keys in ${label}: ${dupes.length ? dupes.join(', ') : 'none'}`);
}

const problems = missingZh.length + missingEn.length + onlyZh.length + onlyEn.length;
process.exitCode = problems > 0 ? 1 : 0;
