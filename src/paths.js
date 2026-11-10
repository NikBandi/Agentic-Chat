// Claim path handling. Claims are repo-relative, forward-slash paths:
//   file  "src/api/users.ts"   dir "src/api/" (covers everything inside)   glob "src/**/*.css"
import path from 'node:path';

export const FOLD = process.platform === 'win32'; // case-insensitive compare on Windows

/** Normalize a user-supplied claim path: forward slashes, no leading ./, no duplicate slashes. */
export function normPath(p) {
  let s = String(p).trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  if (s === '.' || s === '') return '';
  return s;
}

/** Absolute (or cwd-relative) file path -> repo-relative forward-slash path, or null if outside root. */
export function toRepoPath(file, root) {
  const rel = path.relative(root, path.resolve(root, file));
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || rel.startsWith('../') || path.isAbsolute(rel)) return null;
  return normPath(rel);
}

export const isGlob = (p) => /[*?[{]/.test(p);
export const isDir = (p) => p.endsWith('/');

const key = (p, fold) => (fold ? p.toLowerCase() : p);

const reCache = new Map();
export function globToRegExp(glob, fold = FOLD) {
  const k = (fold ? 'i:' : 's:') + glob;
  if (reCache.has(k)) return reCache.get(k);
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { re += '(?:'; depth++; }
    else if (c === '}' && depth) { re += ')'; depth--; }
    else if (c === ',' && depth) re += '|';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else { re += '[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = end; }
    } else re += c.replace(/[.+^$()|\\\]]/g, '\\$&');
  }
  const out = new RegExp('^' + re + '$', fold ? 'i' : '');
  reCache.set(k, out);
  return out;
}

/** Does `claim` cover the concrete file path `file`? */
export function covers(claim, file, fold = FOLD) {
  if (isGlob(claim)) return globToRegExp(claim, fold).test(file);
  const c = key(claim, fold), f = key(file, fold);
  if (isDir(c)) return f.startsWith(c) || f + '/' === c;
  return f === c || f.startsWith(c + '/');
}

/** Literal part of a glob up to the last "/" before its first wildcard. */
function staticPrefix(glob) {
  const first = glob.search(/[*?[{]/);
  const head = first === -1 ? glob : glob.slice(0, first);
  return head.slice(0, head.lastIndexOf('/') + 1);
}

/** Literal extension a glob is limited to ("src/**\/*.css" -> ".css"), or null. */
function globExt(glob) {
  const m = /(?:^|\/)\*(\.[\w.-]+)$/.exec(glob);
  return m ? m[1] : null;
}

/** Could claims `a` and `b` ever cover the same file? Conservative for glob-vs-glob and glob-vs-dir. */
export function overlaps(a, b, fold = FOLD) {
  const ga = isGlob(a), gb = isGlob(b);
  if (!ga && !gb) return covers(a, b, fold) || covers(b, a, fold);
  if (ga && gb) {
    const ea = globExt(a), eb = globExt(b);
    if (ea && eb) { // ".min.js" vs ".js" can both match x.min.js; ".css" vs ".js" never overlap
      const xa = key(ea, fold), xb = key(eb, fold);
      if (!xa.endsWith(xb) && !xb.endsWith(xa)) return false;
    }
    const pa = key(staticPrefix(a), fold), pb = key(staticPrefix(b), fold);
    return pa.startsWith(pb) || pb.startsWith(pa);
  }
  const [g, c] = ga ? [a, b] : [b, a];
  if (covers(g, c, fold)) return true;
  // covers() lets a plain path ("src/api") cover what's beneath it too. Treat it as a possible
  // directory only when its last segment has no extension, so "src/a/b.js" stays a file.
  const dirLike = isDir(c) || !/\.[^/]+$/.test(c);
  if (!dirLike) return false;
  const p = key(staticPrefix(g), fold), d = key(isDir(c) ? c : c + '/', fold);
  return p.startsWith(d) || d.startsWith(p);
}
