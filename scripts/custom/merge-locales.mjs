#!/usr/bin/env node
// Three-way merge of locale JSON files by key rather than by line.
//
//   node scripts/custom/merge-locales.mjs <baseRev> <oursRev> <theirsRev> <file>...
//
// Starts from the `theirs` document (its key order and line endings win) and
// re-applies every leaf that `ours` added or changed relative to `base`.
// When joining the conflict blocks in the work-tree file gives the same
// document, that is written instead, so the file keeps its formatting.
// Writes each file in place; exits 1 if a key was changed on both sides.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [baseRev, oursRev, theirsRev, ...files] = process.argv.slice(2);
if (!baseRev || !oursRev || !theirsRev || files.length === 0) {
  console.error('usage: merge-locales.mjs <baseRev> <oursRev> <theirsRev> <file>...');
  process.exit(2);
}

const show = (rev, file) => {
  try {
    return execFileSync('git', ['show', `${rev}:${file}`], { encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch {
    return null;
  }
};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const canonical = (v) => JSON.stringify(v, (_, x) => (isObj(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

// Keeps the file's own formatting: each conflict block becomes ours then
// theirs, joined by a comma. Only right when both sides appended keys to the
// same object, so the caller checks the result against the by-key merge.
function unionConflictBlocks(text, eol) {
  if (!text.includes('<<<<<<< ')) return null;
  return text.replace(
    /^<<<<<<< [^\n]*\n([\s\S]*?)^(?:\|\|\|\|\|\|\| [^\n]*\n[\s\S]*?)?^=======\r?\n([\s\S]*?)^>>>>>>> [^\n]*\n/gm,
    (_, ours, theirs) => {
      const o = ours.replace(/\s+$/, '');
      const t = theirs.replace(/\s+$/, '');
      if (!o || !t) return (o || t) + eol;
      return (o.endsWith(',') ? o : `${o},`) + eol + t + eol;
    },
  );
}

function apply(base, ours, theirs, path, conflicts) {
  const out = {};
  const oursKeys = Object.keys(ours);
  const added = oursKeys.filter((k) => !(k in base) && !(k in theirs));
  const after = new Map();
  for (const k of added) {
    let prev = null;
    for (let i = oursKeys.indexOf(k) - 1; i >= 0; i--) {
      if (oursKeys[i] in theirs || added.includes(oursKeys[i])) { prev = oursKeys[i]; break; }
    }
    if (!after.has(prev)) after.set(prev, []);
    after.get(prev).push(k);
  }
  const emitAfter = (k) => {
    for (const a of after.get(k) ?? []) { out[a] = ours[a]; emitAfter(a); }
  };

  emitAfter(null);
  for (const k of Object.keys(theirs)) {
    const b = base[k], o = ours[k], t = theirs[k];
    if (k in base && !(k in ours)) {
      if (!same(t, b)) conflicts.push(`${path}${k} (removed by us, changed upstream)`);
      else { emitAfter(k); continue; }
    }
    if (isObj(o) && isObj(t)) out[k] = apply(isObj(b) ? b : {}, o, t, `${path}${k}.`, conflicts);
    else if (o !== undefined && !same(o, b)) {
      if (k in base && !same(t, b) && !same(t, o)) conflicts.push(`${path}${k}`);
      out[k] = o;
    } else out[k] = t;
    emitAfter(k);
  }
  for (const k of oursKeys) {
    if (k in base && !(k in theirs) && !same(ours[k], base[k])) {
      conflicts.push(`${path}${k} (changed by us, removed upstream)`);
    }
  }
  return out;
}

let failed = false;
for (const file of files) {
  const theirsRaw = show(theirsRev, file);
  const oursRaw = show(oursRev, file);
  if (theirsRaw === null || oursRaw === null) {
    console.error(`${file}: missing on one side, resolve by hand`);
    failed = true;
    continue;
  }
  const baseRaw = show(baseRev, file) ?? '{}';
  const conflicts = [];
  const merged = apply(JSON.parse(baseRaw), JSON.parse(oursRaw), JSON.parse(theirsRaw), '', conflicts);
  const eol = theirsRaw.includes('\r\n') ? '\r\n' : '\n';
  let text = JSON.stringify(merged, null, 2).replace(/\n/g, eol);
  if (/\r?\n$/.test(theirsRaw)) text += eol;
  try {
    const current = readFileSync(file, 'utf8');
    const candidate = unionConflictBlocks(current, eol) ?? current;
    if (canonical(JSON.parse(candidate)) === canonical(merged)) text = candidate;
  } catch { /* missing or not valid JSON: keep the by-key merge */ }
  writeFileSync(file, text);
  if (conflicts.length) {
    console.error(`${file}: changed on both sides: ${conflicts.join(', ')}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
