// mend: one patch tool for every AI edit format.
//
// mend reads an edit an AI model wrote and applies it to the tree of text
// files in the working directory. Models write edits in four formats: a
// unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the
// V4A patch format, and text-editor tool calls as JSON. Each format is read
// exactly as SPEC.md says, and every file is changed or none is: a failed
// edit changes nothing, and when any edit fails no file is written at all.
//
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// with the working directory as the root of the tree. When MAKEFUN_ENV_URL
// is set, this file hands the run over to runner.ts, which runs the trial.
// Node 22, standard library only; no dependencies, no network, no clocks.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 failure: the one line mend prints for it. */
class ParseErr {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit's failure: its code and the path it concerns. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

/** A move an edit performed, for the R line of the output. */
interface MoveRec {
  old: string;
  new: string;
}

/** One edit: a function of the tree that throws EditFail when it fails. */
type EditFn = (tree: Tree) => void;

const isBlank = (s: string): boolean => s.trim() === '';

/**
 * A patch's lines: its text split at \n, one trailing \r removed from each
 * line, and the empty piece after a final \n dropped.
 */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, not absolute, holds no backslash, and none of its segments is empty, . or ... */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** Byte order of the UTF-8 encodings, for sorting output paths. */
function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * A file as lines: its own line break (CRLF when its first line feed follows
 * a carriage return, LF otherwise), its lines, and whether it ends with a
 * line break. An empty file has no lines and no final break.
 */
interface Doc {
  br: string;
  lines: string[];
  eol: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { br: '\n', lines: [], eol: false };
  const first = text.indexOf('\n');
  const br = first > 0 && text[first - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const eol = text.endsWith(br);
  if (eol) parts.pop();
  return { br, lines: parts, eol };
}

function renderDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.eol ? d.br : '');
}

/**
 * The tree as the edits leave it. `now` holds every path an edit touched
 * (null: deleted); anything else is read from disk, once, and remembered.
 * The disk never changes while the edits run: files are only written at the
 * end, when every edit has succeeded.
 */
class Tree {
  private readonly disk = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();

  original(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    const got = this.disk.get(p);
    return got === undefined ? null : got;
  }

  get(p: string): string | null {
    if (this.now.has(p)) {
      const got = this.now.get(p);
      return got === undefined ? null : got;
    }
    return this.original(p);
  }
}

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC.md section 5)                                  */
/* ------------------------------------------------------------------ */

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position at or after `from` where `old` occurs in `lines` at `tier`. Occurrences may overlap. */
function occurrences(lines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (!lineEq(lines[i + j] as string, old[j] as string, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier (0, then 1, then 2; only 0 with --strict) at which `old`
 * occurs at or after `from`, with every occurrence at that tier.
 */
function findAtTier(
  lines: string[],
  old: string[],
  from: number,
  strict: boolean,
): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrences(lines, old, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** The first line at or after `from` equal to one line, at the first tier where one is; -1 when there is none. */
function findLine(lines: string[], one: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i] as string, one, tier)) return i;
    }
  }
  return -1;
}

/**
 * One line of the new text: its text, and for a context line its index in
 * the old lines (-1 for a line only the new text has).
 */
interface NewLine {
  text: string;
  ctx: number;
}

/**
 * Build the replacement lines for a match at `at`: a context line is the
 * file's own matched line, never the patch's. At tier 2 every other line is
 * re-indented: the leading spaces and tabs of the file's first matched line
 * (F) replace those of the old text's first line (P) where the line starts
 * with P. At tiers 0 and 1 the new lines are written as they are.
 */
function buildNew(lines: string[], at: number, tier: number, old: string[], spec: NewLine[]): string[] {
  const out: string[] = [];
  const f = tier === 2 && old.length > 0 ? leadingWs(lines[at] as string) : '';
  const p = tier === 2 && old.length > 0 ? leadingWs(old[0] as string) : '';
  for (const n of spec) {
    if (n.ctx >= 0) {
      out.push(lines[at + n.ctx] as string);
    } else if (tier === 2 && n.text !== '' && n.text.trim() !== '' && n.text.startsWith(p)) {
      out.push(f + n.text.slice(p.length));
    } else {
      out.push(n.text);
    }
  }
  return out;
}

/** Split a hunk or chunk body into its old lines and its new-line spec. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A \ line follows this body line. */
  backslash: boolean;
}

function splitItems(items: BodyItem[]): { old: string[]; nspec: NewLine[] } {
  const old: string[] = [];
  const nspec: NewLine[] = [];
  for (const item of items) {
    if (item.kind === 'ctx') {
      nspec.push({ text: item.text, ctx: old.length });
      old.push(item.text);
    } else if (item.kind === 'old') {
      old.push(item.text);
    } else {
      nspec.push({ text: item.text, ctx: -1 });
    }
  }
  return { old, nspec };
}

/** Whether a \ line follows the hunk or chunk's last context or + line. */
function lastNewBackslash(items: BodyItem[]): boolean {
  for (let k = items.length - 1; k >= 0; k--) {
    const item = items[k] as BodyItem;
    if (item.kind === 'ctx' || item.kind === 'new') return item.backslash;
  }
  return false;
}

/** One body line of a hunk or chunk: a leading space or an empty line is context, - old, + new. */
function bodyItem(line: string): BodyItem {
  if (line === '') return { kind: 'ctx', text: '', backslash: false };
  if (line.startsWith(' ')) return { kind: 'ctx', text: line.slice(1), backslash: false };
  if (line.startsWith('-')) return { kind: 'old', text: line.slice(1), backslash: false };
  return { kind: 'new', text: line.slice(1), backslash: false };
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when the value is not one. */
function jsonEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const read = (tree: Tree): string => {
    if (!isSafe(p)) throw new EditFail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditFail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = read(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = read(tree);
      const doc = parseDoc(before);
      if (line < 0 || line > doc.lines.length) throw new EditFail('no-match', p);
      doc.lines.splice(line, 0, ...add);
      tree.now.set(p, renderDoc(doc));
    };
  }
  return null;
}

/** The edits of a JSON patch: one array, or one edit object a line. */
function jsonEdits(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseErr('error: parse 1');
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseErr(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseErr(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseErr(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseErr(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  /** The old start line A (1-based) from the @@ header. */
  a: number;
  items: BodyItem[];
}

interface UniSection {
  /** The --- path: undefined when no --- line named it, null for /dev/null. */
  oldFromHeader: string | null | undefined;
  /** The +++ path: undefined when no +++ line named it, null for /dev/null. */
  newFromHeader: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  gitX: string | null;
  gitY: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * A --- or +++ path: the text after the four characters, up to the first
 * tab, with surrounding spaces removed; a leading a/ or b/ removed.
 * /dev/null means no file.
 */
function cleanUniPath(raw: string): string | null {
  let p = raw.split('\t')[0].trim();
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

function parseDiffGit(line: string, no: number): { x: string; y: string } {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (m === null) throw new ParseErr(`error: parse ${no}`);
  return { x: m[1] as string, y: m[2] as string };
}

/** Parse a unified patch into its sections, in patch order. */
function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let header = false;
  const startSection = (gitX: string | null, gitY: string | null): UniSection => {
    const s: UniSection = {
      oldFromHeader: undefined,
      newFromHeader: undefined,
      renameFrom: null,
      renameTo: null,
      gitX,
      gitY,
      create: false,
      remove: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    header = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const next = lines[i + 1];
    // SPEC section 6: a `diff --git` line not of the form `diff --git a/<X>
    // b/<Y>` is a parse error at its line. That includes the bare token
    // `diff --git` on its own; `diff --gitx` is not a `diff --git` line.
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const g = parseDiffGit(line, i + 1);
      startSection(g.x, g.y);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (next ?? '').startsWith('+++ ')) {
      if (cur !== null && header) {
        cur.oldFromHeader = cleanUniPath(line.slice(4));
        cur.newFromHeader = cleanUniPath((next as string).slice(4));
      } else {
        const s = startSection(null, null);
        s.oldFromHeader = cleanUniPath(line.slice(4));
        s.newFromHeader = cleanUniPath((next as string).slice(4));
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new ParseErr(`error: parse ${i + 1}`);
      if (cur === null) throw new ParseErr(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i += 1;
      const items: BodyItem[] = [];
      while (i < lines.length) {
        const l = lines[i] as string;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
          if (l.startsWith('\\')) {
            if (items.length > 0) (items[items.length - 1] as BodyItem).backslash = true;
          } else {
            items.push(bodyItem(l));
          }
          i += 1;
        } else {
          break;
        }
      }
      while (
        items.length > 0 &&
        (items[items.length - 1] as BodyItem).kind === 'ctx' &&
        (items[items.length - 1] as BodyItem).text === '' &&
        !(items[items.length - 1] as BodyItem).backslash
      ) {
        items.pop();
      }
      cur.hunks.push({ a, items });
      header = false;
      continue;
    }
    if (cur !== null && header) {
      if (line.startsWith('--- ')) throw new ParseErr(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.newFromHeader = cleanUniPath(line.slice(4));
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.remove = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** Apply a section's hunks in order, each to the result of the ones before it. */
function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { old, nspec } = splitItems(h.items);
    const noBreak = lastNewBackslash(h.items);
    if (old.length === 0) {
      const at = Math.min(h.a + d, doc.lines.length);
      const touchesEnd = at === doc.lines.length;
      const built = buildNew(doc.lines, at, 0, [], nspec);
      doc.lines.splice(at, 0, ...built);
      if (touchesEnd) doc.eol = !noBreak;
      d += nspec.length;
      continue;
    }
    const found = findAtTier(doc.lines, old, 0, strict);
    if (found === null) throw new EditFail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.at[0] as number;
    let bestDist = Math.abs(best - target);
    for (const pos of found.at) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const touchesEnd = best + old.length === doc.lines.length;
    const built = buildNew(doc.lines, best, found.tier, old, nspec);
    doc.lines.splice(best, old.length, ...built);
    if (touchesEnd) doc.eol = !noBreak;
    d += nspec.length - old.length;
  }
}

/** The edits of a unified patch: one edit per section. */
function unifiedEdits(sections: UniSection[], strict: boolean, moves: MoveRec[]): EditFn[] {
  const edits: EditFn[] = [];
  for (const s of sections) {
    // A ---/+++ pair names the paths even when it names /dev/null (null);
    // only when no such line named a path do rename and diff --git fall back.
    const oldP = s.oldFromHeader !== undefined ? s.oldFromHeader : (s.renameFrom ?? s.gitX ?? null);
    const newP = s.newFromHeader !== undefined ? s.newFromHeader : (s.renameTo ?? s.gitY ?? null);
    edits.push((tree) => {
      if (oldP !== null && !isSafe(oldP)) throw new EditFail('unsafe', oldP);
      if (newP !== null && !isSafe(newP)) throw new EditFail('unsafe', newP);
      if (s.create || oldP === null) {
        const p = newP === null ? '' : newP;
        if (!isSafe(p)) throw new EditFail('unsafe', p);
        if (tree.get(p) !== null) throw new EditFail('exists', p);
        const plus: string[] = [];
        let lastPlus: BodyItem | null = null;
        for (const h of s.hunks) {
          for (const item of h.items) {
            if (item.kind === 'new') {
              plus.push(item.text);
              lastPlus = item;
            }
          }
        }
        const text = plus.length === 0 ? '' : plus.join('\n') + (lastPlus !== null && lastPlus.backslash ? '' : '\n');
        tree.now.set(p, text);
        return;
      }
      if (s.remove || newP === null) {
        const p = oldP as string;
        if (tree.get(p) === null) throw new EditFail('missing', p);
        tree.now.set(p, null);
        return;
      }
      if (oldP !== newP) {
        const from = oldP as string;
        const to = newP as string;
        if (tree.get(from) === null) throw new EditFail('missing', from);
        if (tree.get(to) !== null) throw new EditFail('exists', to);
        const doc = parseDoc(tree.get(from) as string);
        applyHunks(doc, s.hunks, strict, from);
        tree.now.set(to, renderDoc(doc));
        tree.now.set(from, null);
        moves.push({ old: from, new: to });
        return;
      }
      const p = oldP as string;
      if (tree.get(p) === null) throw new EditFail('missing', p);
      const doc = parseDoc(tree.get(p) as string);
      applyHunks(doc, s.hunks, strict, p);
      tree.now.set(p, renderDoc(doc));
    });
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): EditFn {
  return (tree) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new EditFail('missing', path);
    const doc = parseDoc(cur);
    const found = findAtTier(doc.lines, oldLines, 0, strict);
    if (found === null) throw new EditFail('no-match', path);
    if (found.at.length > 1) throw new EditFail('ambiguous', path);
    const at = found.at[0] as number;
    const built = buildNew(
      doc.lines,
      at,
      found.tier,
      oldLines,
      newLines.map((t) => ({ text: t, ctx: -1 })),
    );
    doc.lines.splice(at, oldLines.length, ...built);
    tree.now.set(path, renderDoc(doc));
  };
}

/** Parse a SEARCH/REPLACE patch into its block edits, in patch order. */
function srEdits(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchNo = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      // SPEC section 7: a SEARCH line with no ======= and then >>>>>>> REPLACE
      // after it is a parse error at the SEARCH line. The separator must come
      // before the block's end (or the next block); scanning past either
      // would swallow the next block's lines as this block's old lines.
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') throw new ParseErr(`error: parse ${searchNo}`);
    }
    if (eq < 0) throw new ParseErr(`error: parse ${searchNo}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      // A block with no >>>>>>> REPLACE before the next block starts is a
      // parse error at its SEARCH line; scanning past it would swallow the
      // next block's lines as this block's new lines.
      if (t === '<<<<<<< SEARCH') throw new ParseErr(`error: parse ${searchNo}`);
    }
    if (rep < 0) throw new ParseErr(`error: parse ${searchNo}`);
    let path: string | null = null;
    for (let j = i - 1; j > prevReplace; j--) {
      const t = lines[j] as string;
      if (t.trim() === '') continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseErr(`error: parse ${searchNo}`);
      path = prevPath;
    }
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}

function v4aAdd(path: string, addLines: string[]): EditFn {
  return (tree) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    if (tree.get(path) !== null) throw new EditFail('exists', path);
    tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
  };
}

function v4aDelete(path: string): EditFn {
  return (tree) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    if (tree.get(path) === null) throw new EditFail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdate(
  path: string,
  raw: string[],
  headerIdx: number,
  strict: boolean,
  moves: MoveRec[],
): EditFn {
  let moveTo: string | null = null;
  let at = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice('*** Move to: '.length).trim();
    at = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  const lineNo = (k: number): number => headerIdx + k + 2;
  for (let k = at; k < raw.length; k++) {
    const l = raw[k] as string;
    if (l.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
    } else if (l === '*** End of File') {
      if (cur === null) cur = { anchor: null, items: [], eof: false };
      cur.eof = true;
      chunks.push(cur);
      cur = null;
    } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new ParseErr(`error: parse ${lineNo(k)}`);
        cur = { anchor: null, items: [], eof: false };
      }
      cur.items.push(bodyItem(l));
    } else {
      throw new ParseErr(`error: parse ${lineNo(k)}`);
    }
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new ParseErr(`error: parse ${headerIdx + 1}`);
  return (tree) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    if (moveTo !== null && !isSafe(moveTo)) throw new EditFail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new EditFail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFail('exists', moveTo);
    const doc = parseDoc(curText);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const a = findLine(doc.lines, ch.anchor, cursor, strict);
        if (a < 0) throw new EditFail('no-match', path);
        cursor = a + 1;
      }
      const { old, nspec } = splitItems(ch.items);
      if (old.length === 0) {
        const atPos = ch.eof ? doc.lines.length : cursor;
        const built = buildNew(doc.lines, atPos, 0, [], nspec);
        doc.lines.splice(atPos, 0, ...built);
        cursor = atPos + built.length;
        continue;
      }
      const found = findAtTier(doc.lines, old, cursor, strict);
      if (found === null) throw new EditFail('no-match', path);
      let occ = found.at;
      if (ch.eof) occ = occ.filter((pos) => pos + old.length === doc.lines.length);
      if (occ.length === 0) throw new EditFail('no-match', path);
      const atPos = occ[0] as number;
      const built = buildNew(doc.lines, atPos, found.tier, old, nspec);
      doc.lines.splice(atPos, old.length, ...built);
      cursor = atPos + built.length;
    }
    const out = renderDoc(doc);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

/** Parse a V4A patch into its section edits, in patch order. */
function v4aEdits(lines: string[], strict: boolean, moves: MoveRec[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseErr('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseErr(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k] as string)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseErr(`error: parse ${lines.length + 1}`);
  const isStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: EditFn[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i] as string)) {
      i += 1;
      continue;
    }
    const line = lines[i] as string;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new ParseErr(`error: parse ${i + 1}`);
    }
    let j = i + 1;
    while (j < last && !isStart(lines[j] as string)) j += 1;
    const raw = lines.slice(i + 1, j);
    while (raw.length > 0 && isBlank(raw[raw.length - 1] as string)) raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k] as string;
        if (l === '') addLines.push('');
        else if (l.startsWith('+')) addLines.push(l.slice(1));
        else throw new ParseErr(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aAdd(path, addLines));
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k++) {
        if (!isBlank(raw[k] as string)) throw new ParseErr(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aDelete(path));
    } else {
      edits.push(v4aUpdate(path, raw, i, strict, moves));
    }
    i = j;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Detecting the format (SPEC.md section 4)                            */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Running the whole patch (SPEC.md sections 1, 2 and 10)              */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return { code: 2, out: ['error: usage'] };
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
      continue;
    }
    pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0];
  let text = '';
  try {
    text = readFileSync(file === null ? 0 : file, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: MoveRec[] = [];
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(parseUnified(lines), strict, moves);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new ParseErr('error: parse 1');
  } catch (e) {
    if (e instanceof ParseErr) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  for (const m of moves) {
    const oldWas = tree.original(m.old);
    const oldNow = tree.get(m.old);
    const newWas = tree.original(m.new);
    const newNow = tree.get(m.new);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      suppressed.add(m.old);
      suppressed.add(m.new);
    }
  }
  for (const p of tree.now.keys()) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p);
    if (was === now) continue;
    const line = was === null ? `A ${p}` : now === null || now === undefined ? `D ${p}` : `M ${p}`;
    rows.push({ key: p, line });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      const was = tree.original(p);
      const now = tree.now.get(p);
      if (was === now) continue;
      try {
        if (now === null || now === undefined) {
          rmSync(p, { force: true });
        } else {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, now);
        }
      } catch {
        // A path the tree cannot hold (a directory where a file should be,
        // a file where a directory should be): nothing in the spec covers
        // it, so the write is left undone and the run goes on.
      }
    }
  }
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable set.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
