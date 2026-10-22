import { describe, expect, it } from 'vitest';
import { diffHasLine, parseFilePatch, parseUnifiedDiff, splitRows } from '../src/shared/diff';

const modified = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@ export function start() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
 const e = 6;
@@ -20,3 +21,2 @@ function tail() {
 keep();
-drop();
 end();
`;

describe('unified diff parser', () => {
  it('numbers lines across multiple hunks', () => {
    const file = parseFilePatch(modified);
    expect(file).toMatchObject({ status: 'modified', oldPath: 'src/app.ts', newPath: 'src/app.ts', additions: 2, deletions: 2, truncated: false });
    expect(file.hunks).toHaveLength(2);
    expect(file.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 5, section: 'export function start() {' });
    expect(file.hunks[0].lines.map((line) => [line.type, line.oldLine, line.newLine])).toEqual([
      ['context', 1, 1], ['remove', 2, undefined], ['add', undefined, 2], ['add', undefined, 3], ['context', 3, 4], ['context', 4, 5],
    ]);
    expect(file.hunks[1].lines.map((line) => [line.type, line.oldLine, line.newLine])).toEqual([['context', 20, 21], ['remove', 21, undefined], ['context', 22, 22]]);
    expect(diffHasLine(file, 'new', 3)).toBe(true);
    expect(diffHasLine(file, 'old', 21)).toBe(true);
    expect(diffHasLine(file, 'new', 10)).toBe(false);
  });

  it('pairs removals and additions for side-by-side rows', () => {
    const rows = splitRows(parseFilePatch(modified).hunks[0]);
    expect(rows.map((row) => [row.left?.oldLine, row.right?.newLine])).toEqual([[1, 1], [2, 2], [undefined, 3], [3, 4], [4, 5]]);
  });

  it('recognises new and deleted files', () => {
    const [added, deleted] = parseUnifiedDiff(`diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3b18e51
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 3b18e51..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
`);
    expect(added).toMatchObject({ status: 'added', oldPath: undefined, newPath: 'new.txt', additions: 2, deletions: 0 });
    expect(added.hunks[0].lines.map((line) => line.newLine)).toEqual([1, 2]);
    expect(deleted).toMatchObject({ status: 'deleted', oldPath: 'old.txt', newPath: undefined, additions: 0, deletions: 1 });
    expect(deleted.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0 });
  });

  it('recognises renames with and without content changes', () => {
    const [pure, edited] = parseUnifiedDiff(`diff --git a/a.js b/b.js
similarity index 100%
rename from a.js
rename to b.js
diff --git a/lib/x.js b/lib/y.js
similarity index 90%
rename from lib/x.js
rename to lib/y.js
index 1..2 100644
--- a/lib/x.js
+++ b/lib/y.js
@@ -1 +1 @@
-old
+new
`);
    expect(pure).toMatchObject({ status: 'renamed', oldPath: 'a.js', newPath: 'b.js', similarity: 100, hunks: [] });
    expect(edited).toMatchObject({ status: 'renamed', oldPath: 'lib/x.js', newPath: 'lib/y.js', similarity: 90, additions: 1, deletions: 1 });
  });

  it('marks lines without a trailing newline', () => {
    const file = parseFilePatch(`--- a/x
+++ b/x
@@ -1 +1 @@
-one
\\ No newline at end of file
+one
`);
    expect(file.hunks[0].lines).toEqual([{ type: 'remove', text: 'one', oldLine: 1, noNewline: true }, { type: 'add', text: 'one', newLine: 1 }]);
    expect(file.truncated).toBe(false);
  });

  it('detects binary files and mode changes', () => {
    const [binary, mode] = parseUnifiedDiff(`diff --git a/logo.png b/logo.png
index 1..2 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`);
    expect(binary).toMatchObject({ status: 'binary', binary: true, hunks: [] });
    expect(mode).toMatchObject({ status: 'modified', modeChange: { from: '100644', to: '100755' } });
  });

  it('flags a patch cut off inside its last hunk', () => {
    const cut = modified.split('\n').slice(0, 9).join('\n');
    const file = parseFilePatch(cut);
    expect(file.truncated).toBe(true);
    expect(file.hunks).toHaveLength(1);
  });

  it('keeps headerless fragments without inventing line numbers', () => {
    const file = parseFilePatch('-2\n+4', 'src/batch.mjs');
    expect(file).toMatchObject({ oldPath: 'src/batch.mjs', newPath: 'src/batch.mjs', additions: 1, deletions: 1 });
    expect(file.hunks[0].numbered).toBe(false);
    expect(diffHasLine(file, 'new', 1)).toBe(false);
  });

  it('handles an empty patch', () => {
    expect(parseFilePatch('')).toMatchObject({ hunks: [], additions: 0, deletions: 0 });
  });
});
