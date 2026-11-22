# mend

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits
in four formats, and `mend` reads all four: a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. Every file
is changed, or nothing is.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the patch file, or `-` (or nothing) to read the patch from standard input. The
working directory is the root of the tree, and every path in a patch is relative to it.

## How an edit is applied

- **Format.** `--format=auto` (the default) detects the format: `*** Begin Patch` means
  V4A, a first character of `[` or `{` means JSON, a `<<<<<<< SEARCH` line means
  SEARCH/REPLACE, a `diff --git` line or a `---`/`+++` pair means a unified diff. A format
  named with `--format` is read as that format whatever the text holds.
- **Matching.** The lines an edit names are found at the first of three tiers where they
  occur: exactly; then ignoring trailing spaces and tabs; then ignoring leading and
  trailing spaces and tabs. `--strict` tries the exact tier only. A unified hunk takes the
  occurrence nearest its (possibly wrong) line number, adjusted for earlier hunks; a
  SEARCH/REPLACE block fails as ambiguous when its old lines occur more than once; a V4A
  chunk follows its anchor and its cursor, and an end-of-file chunk only takes an
  occurrence that ends at the file's last line. Context lines are written as the file's
  own lines, and at the third tier new lines are re-indented to the file's indentation.
- **Files.** A changed file keeps its own line break (CRLF or LF) and its final line
  break, unless a unified hunk says otherwise; `\ No newline at end of file` is honoured.
  A file an edit creates is written with LF breaks. Edits apply in the patch's order,
  each to the tree as earlier edits left it.
- **Atomicity.** When any edit fails, no file is written at all, and the edits after the
  failed one still run so every failure is reported. `--check` does everything but write:
  the same output and exit code, no file created, changed or deleted.

## Output and exit codes

Standard output holds lines, each ended by `\n`, and nothing else.

- Exit 0: one line per changed path — `A <path>` for a file created, `D <path>` for one
  deleted, `M <path>` for one changed, `R <old> -> <new>` for a file a move edit moved —
  then `ok: <n> files` (`ok: 1 file` when n is 1). A file whose bytes are unchanged is not
  listed; a patch that changes nothing prints only `ok: 0 files`.
- Exit 1: one line `error: <code> <path>` per failed edit, in the patch's order, then
  `failed: <k> of <n> edits`. The codes are `no-match`, `ambiguous`, `missing`, `exists`
  and `unsafe`.
- Exit 2, nothing written: `error: usage`, `error: no-patch`, `error: format`, or
  `error: parse <N>` with the 1-based patch line that could not be read.

`SPEC.md` in the kit is the whole specification this implements. Node 22 and its standard
library alone; there is nothing to install.

## The files

- `main.ts`: the CLI.
- `runner.ts`: the kit's trial runner, kept as it is. When `MAKEFUN_ENV_URL` is set,
  `main.ts` hands the trial over to it: it reads the checks from the env, runs `main.ts`
  on each one in a fresh directory, and posts the exit code, stdout and files left behind.
- `LICENSE`: MIT.

## Checking it

The kit carries 100 public practice checks at `program/generator/practice.json`; `check.ts`
in the kit's starter runs them against this `main.ts`:

    node check.ts ../program/generator/practice.json

It prints every check the CLI gets wrong, with what differed, and the practice score.
This entry passes all 100: 30 unified, 20 SEARCH/REPLACE, 20 V4A, 15 JSON and 15 CLI
checks, for a practice score of 1000.
