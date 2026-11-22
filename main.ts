// main.ts is mend, the CLI SPEC.md specifies. It applies an edit an AI model wrote, in one of four
// formats (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON edits), to a tree of text files.
// SPEC.md is the whole contract: every file is changed or nothing is, and the output names what
// changed or why an edit failed. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// Sections 1 to 4 (invocation, output and exit codes, safe paths, format detection), 9 (JSON edits)
// and 10 (order and atomicity) follow the kit's starter. Sections 5 to 8 are written here: the
// three-tier line matching, unified diffs, SEARCH/REPLACE blocks and V4A patches, plus the
// `R <old> -> <new>` line section 2 asks for when a move edit succeeds.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and
// write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A move a successful edit made, for the `R <old> -> <new>` output line. */
interface Move {
  oldPath: string;
  newPath: string;
}

type Edit = (tree: Tree) => Move | void;

// ---------------------------------------------------------------------------
// Section 5: files, lines and three-tier matching
// ---------------------------------------------------------------------------

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  let br = '\n';
  const nl = text.indexOf('\n');
  if (nl > 0 && text[nl - 1] === '\r') br = '\r\n';
  if (text === '') return { lines: [], br, final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Every 0-based position where O occurs in lines at this tier; occurrences may overlap. */
function occurrences(O: string[], lines: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (!lineEq(O[k]!, lines[i + k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its occurrences, or null. */
function findTier(O: string[], lines: string[], from: number, strict: boolean): { tier: number; occs: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occs = occurrences(O, lines, t).filter((i) => i >= from);
    if (occs.length > 0) return { tier: t, occs };
  }
  return null;
}

/** One line of a hunk or chunk body: a context line, an old line, or a new line. */
interface Item {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

/**
 * The lines that replace a matched occurrence. A context line is written as the file's own
 * matched line, never the patch's. At tier 2 every other line is re-indented: the leading
 * spaces and tabs of O's first line are replaced by those of the file's first matched line.
 */
function buildReplacement(items: Item[], fileLines: string[], pos: number, tier: number): string[] {
  const O = items.filter((it) => it.kind !== 'new');
  const F = tier === 2 && O.length > 0 ? leadWs(fileLines[pos] ?? '') : '';
  const P = tier === 2 && O.length > 0 ? leadWs(O[0]!.text) : '';
  const out: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi++;
    } else if (it.kind === 'old') {
      oi++;
    } else {
      let t = it.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

interface Hunk {
  /** A from `@@ -A[,B] +C[,D] @@` (B and D are not used). */
  a: number;
  items: Item[];
  /** A `\` line follows the hunk's last context or `+` line. */
  backslashAfterLast: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  backslashAfterLastPlus: boolean;
  /** The hunk has a `+` line. */
  hasPlus: boolean;
}

function makeHunk(a: number, body: string[]): Hunk {
  type Raw = { type: 'ctx' | 'old' | 'new' | 'bs'; text: string };
  const raw: Raw[] = [];
  for (const l of body) {
    if (l.startsWith('\\')) raw.push({ type: 'bs', text: l });
    else if (l.startsWith(' ')) raw.push({ type: 'ctx', text: l.slice(1) });
    else if (l.startsWith('-')) raw.push({ type: 'old', text: l.slice(1) });
    else if (l.startsWith('+')) raw.push({ type: 'new', text: l.slice(1) });
    else if (l === '') raw.push({ type: 'ctx', text: '' });
  }
  const after = (pred: (r: Raw) => boolean): boolean => {
    for (let k = raw.length - 1; k >= 0; k--) {
      if (pred(raw[k]!)) return raw[k + 1] !== undefined && raw[k + 1]!.type === 'bs';
    }
    return false;
  };
  const items: Item[] = raw
    .filter((r) => r.type !== 'bs')
    .map((r) => ({ kind: r.type as 'ctx' | 'old' | 'new', text: r.text }));
  return {
    a,
    items,
    backslashAfterLast: after((r) => r.type === 'ctx' || r.type === 'new'),
    backslashAfterLastPlus: after((r) => r.type === 'new'),
    hasPlus: raw.some((r) => r.type === 'new'),
  };
}

/** Apply a section's hunks in order to a file's text; throws Fail on the first bad hunk. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    const O = h.items.filter((it) => it.kind !== 'new').map((it) => it.text);
    const N = h.items.filter((it) => it.kind !== 'old');
    if (O.length > 0) {
      const found = findTier(O, f.lines, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occs[0]!;
      let bestDist = Math.abs(best - target);
      for (let k = 1; k < found.occs.length; k++) {
        const dist = Math.abs(found.occs[k]! - target);
        if (dist < bestDist) {
          best = found.occs[k]!;
          bestDist = dist;
        }
      }
      const replacement = buildReplacement(h.items, f.lines, best, found.tier);
      const atEnd = best + O.length === f.lines.length;
      f.lines = [...f.lines.slice(0, best), ...replacement, ...f.lines.slice(best + O.length)];
      if (atEnd) f.final = !h.backslashAfterLast;
      d += N.length - O.length;
    } else {
      const ins = Math.max(0, Math.min(h.a + d, f.lines.length));
      const replacement = N.map((it) => it.text);
      const atEnd = ins === f.lines.length;
      f.lines = [...f.lines.slice(0, ins), ...replacement, ...f.lines.slice(ins)];
      if (atEnd) f.final = !h.backslashAfterLast;
      d += N.length;
    }
  }
  return joinFile(f);
}

interface Section {
  /** From a `---`/`+++` pair; undefined when there is no pair, null for `/dev/null`. */
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  /** A lone `+++ ` line in the header, when no pair names the new path. */
  loneNew: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function sectionPaths(sec: Section): { oldP: string | null; newP: string | null } {
  const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameOld !== undefined ? sec.renameOld : sec.gitOld !== undefined ? sec.gitOld : null;
  const newP =
    sec.pairNew !== undefined
      ? sec.pairNew
      : sec.renameNew !== undefined
        ? sec.renameNew
        : sec.loneNew !== undefined
          ? sec.loneNew
          : sec.gitNew !== undefined
            ? sec.gitNew
            : null;
  return { oldP, newP };
}

function makeUnifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree: Tree): Move | void => {
    const { oldP, newP } = sectionPaths(sec);
    const isCreate = oldP === null || sec.isCreate;
    const isDelete = newP === null || sec.isDelete;
    if (isCreate) {
      if (newP === null) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plusLines: string[] = [];
      for (const h of sec.hunks) {
        for (const it of h.items) if (it.kind === 'new') plusLines.push(it.text);
      }
      let endsWithBreak = true;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        if (sec.hunks[k]!.hasPlus) {
          endsWithBreak = !sec.hunks[k]!.backslashAfterLastPlus;
          break;
        }
      }
      tree.now.set(newP, plusLines.length === 0 ? '' : plusLines.join('\n') + (endsWithBreak ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const result = sec.hunks.length === 0 ? before : applyHunks(before, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, result);
      return { oldPath: oldP, newPath: newP };
    }
    if (oldP !== null) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      const result = sec.hunks.length === 0 ? before : applyHunks(before, sec.hunks, strict, oldP);
      tree.now.set(oldP, result);
    }
    // Both paths /dev/null: a section that names no file changes nothing.
  };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:\s|$)/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  const newSection = (): Section => ({
    pairOld: undefined,
    pairNew: undefined,
    renameOld: undefined,
    renameNew: undefined,
    gitOld: undefined,
    gitNew: undefined,
    loneNew: undefined,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });
  let cur: Section | null = null;
  let inHeader = false;
  let hasPair = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      hasPair = false;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !hasPair) {
        cur.pairOld = headerPath(l);
        cur.pairNew = headerPath(lines[i + 1]!);
        hasPair = true;
      } else {
        cur = newSection();
        cur.pairOld = headerPath(l);
        cur.pairNew = headerPath(lines[i + 1]!);
        sections.push(cur);
        inHeader = true;
        hasPair = true;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(makeHunk(a, body));
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('rename from ')) {
        if (cur.renameOld === undefined) cur.renameOld = l.slice('rename from '.length).trim();
      } else if (l.startsWith('rename to ')) {
        if (cur.renameNew === undefined) cur.renameNew = l.slice('rename to '.length).trim();
      } else if (l.startsWith('+++ ')) {
        if (!hasPair && cur.loneNew === undefined) cur.loneNew = headerPath(l);
      } else if (l.startsWith('new file mode')) {
        cur.isCreate = true;
      } else if (l.startsWith('deleted file mode')) {
        cur.isDelete = true;
      }
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`,
      // `Index:` and any other header line are ignored.
    }
    // Outside a section header, lines that are not part of a section are ignored.
    i++;
  }
  return sections.map((sec) => makeUnifiedEdit(sec, strict));
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function makeSREdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(oldLines, f.lines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occs.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occs[0]!;
    const items: Item[] = [
      ...oldLines.map((text) => ({ kind: 'old' as const, text })),
      ...newLines.map((text) => ({ kind: 'new' as const, text })),
    ];
    const replacement = buildReplacement(items, f.lines, pos, found.tier);
    const out = [...f.lines.slice(0, pos), ...replacement, ...f.lines.slice(pos + oldLines.length)];
    tree.now.set(path, out.length === 0 ? '' : out.join(f.br) + (f.final ? f.br : ''));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') break;
    }
    if (sep === -1) throw new Exit2(`error: parse ${searchLine}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (end === -1) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(makeSREdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

const ADD_PREFIX = '*** Add File: ';
const DEL_PREFIX = '*** Delete File: ';
const UPD_PREFIX = '*** Update File: ';
const MOVE_PREFIX = '*** Move to: ';

interface V4aChunk {
  /** Null when the chunk has no anchor. */
  anchor: string | null;
  eof: boolean;
  items: Item[];
}

function applyV4aChunks(before: string, chunks: V4aChunk[], strict: boolean, path: string): string {
  const f = splitFile(before);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let found: number | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        for (let j = cursor; j < f.lines.length; j++) {
          if (lineEq(ch.anchor, f.lines[j]!, t)) {
            found = j;
            break;
          }
        }
        if (found !== null) break;
      }
      if (found === null) throw new Fail('no-match', path);
      cursor = found + 1;
    }
    const O = ch.items.filter((it) => it.kind !== 'new').map((it) => it.text);
    const N = ch.items.filter((it) => it.kind !== 'old');
    if (O.length > 0) {
      let tier: number | null = null;
      let pos: number | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        let occs = occurrences(O, f.lines, t).filter((p) => p >= cursor);
        if (ch.eof) occs = occs.filter((p) => p + O.length === f.lines.length);
        if (occs.length > 0) {
          tier = t;
          pos = occs[0]!;
          break;
        }
      }
      if (tier === null || pos === null) throw new Fail('no-match', path);
      const replacement = buildReplacement(ch.items, f.lines, pos, tier);
      f.lines = [...f.lines.slice(0, pos), ...replacement, ...f.lines.slice(pos + O.length)];
      cursor = pos + replacement.length;
    } else {
      const ins = ch.eof ? f.lines.length : cursor;
      const replacement = N.map((it) => it.text);
      f.lines = [...f.lines.slice(0, ins), ...replacement, ...f.lines.slice(ins)];
      cursor = ins + replacement.length;
    }
  }
  return joinFile(f);
}

function makeV4aAdd(path: string, fileLines: string[]): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function makeV4aDelete(path: string): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function makeV4aUpdate(
  path: string,
  raw: { idx: number; text: string }[],
  strict: boolean,
  updateLineNo: number,
): Edit {
  let moveTo: string | null = null;
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let seenChunk = false;
  for (const r of raw) {
    const l = r.text;
    if (l.startsWith(MOVE_PREFIX) && cur === null && !seenChunk && moveTo === null) {
      moveTo = l.slice(MOVE_PREFIX.length).trim();
      continue;
    }
    if (l.startsWith('@@')) {
      const anchorText = l.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, eof: false, items: [] };
      chunks.push(cur);
      seenChunk = true;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.idx + 1}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (seenChunk) throw new Exit2(`error: parse ${r.idx + 1}`);
        cur = { anchor: null, eof: false, items: [] };
        chunks.push(cur);
        seenChunk = true;
      }
      if (l === '') cur.items.push({ kind: 'ctx', text: '' });
      else if (l.startsWith(' ')) cur.items.push({ kind: 'ctx', text: l.slice(1) });
      else if (l.startsWith('-')) cur.items.push({ kind: 'old', text: l.slice(1) });
      else cur.items.push({ kind: 'new', text: l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${r.idx + 1}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
  return (tree: Tree): Move | void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const result = applyV4aChunks(before, chunks, strict, path);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, result);
      return { oldPath: path, newPath: moveTo };
    }
    tree.now.set(path, result);
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith(ADD_PREFIX) || l.startsWith(DEL_PREFIX) || l.startsWith(UPD_PREFIX);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith(ADD_PREFIX)) {
      const path = l.slice(ADD_PREFIX.length).trim();
      const raw: { idx: number; text: string }[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        raw.push({ idx: j, text: lines[j]! });
        j++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      edits.push(makeV4aAdd(path, fileLines));
      i = j;
      continue;
    }
    if (l.startsWith(DEL_PREFIX)) {
      const path = l.slice(DEL_PREFIX.length).trim();
      const raw: { idx: number; text: string }[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        raw.push({ idx: j, text: lines[j]! });
        j++;
      }
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      edits.push(makeV4aDelete(path));
      i = j;
      continue;
    }
    if (l.startsWith(UPD_PREFIX)) {
      const path = l.slice(UPD_PREFIX.length).trim();
      const raw: { idx: number; text: string }[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        raw.push({ idx: j, text: lines[j]! });
        j++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      edits.push(makeV4aUpdate(path, raw, strict, i + 1));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Sections 1, 2 and 10: invocation, output and exit codes, order and atomicity
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Move[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      const m = edit(tree);
      if (m !== undefined) moves.push(m);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move replaces its D and A lines with one `R <old> -> <new>` line, sorting by <new>.
  // Chained moves fold: a file moved twice is reported from where it started.
  const movedFrom = new Map<string, string>();
  for (const m of moves) {
    const orig = movedFrom.get(m.oldPath) ?? m.oldPath;
    movedFrom.delete(m.oldPath);
    movedFrom.set(m.newPath, orig);
  }
  const suppressed = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [newPath, origPath] of movedFrom) {
    const wasOld = tree.original(origPath);
    const nowOld = tree.get(origPath);
    const wasNew = tree.original(newPath);
    const nowNew = tree.get(newPath);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newPath, line: `R ${origPath} -> ${newPath}` });
      suppressed.add(origPath);
      suppressed.add(newPath);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
