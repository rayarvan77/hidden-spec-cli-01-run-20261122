# mend: one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rayarvan77/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rayarvan77/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

An entry for [make.fun](https://make.fun)'s `hidden-spec-cli-01-run-20261122`
bounty: `mend`, a command-line tool that applies an edit an AI model wrote
to a tree of text files, in any of the four formats models write them in.

## What it does

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

Models write edits as a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, or text-editor tool calls as
JSON. `mend` reads all four to one specification (`SPEC.md` in the kit),
finds the lines an edit names even when the model drifted their whitespace
or indentation, and changes every file or none: a failed edit changes
nothing, and when any edit fails no file is written at all.

- **Unified diffs** are matched by content, not by the line numbers the
  model wrote: each hunk takes the occurrence nearest to its stated
  position, so a hunk with wrong numbers still lands where it belongs.
  Creations, deletions and moves (renames) are supported, including hunks
  that run to the end of a file with no final line break.
- **SEARCH/REPLACE blocks** take their path from the nearest line above
  the block, skip code fences, and reuse the previous block's path when a
  block has none; an old block that occurs more than once is ambiguous.
- **V4A patches** apply chunks in order with a cursor, anchor lines, and
  end-of-file chunks, and support add, delete, update and move sections.
- **JSON edits** (`create`, `str_replace`, `insert`) work on one array or
  one object per line, with exact matching and CRLF handling.
- Matching runs at three tiers: exact lines, then lines with trailing
  whitespace ignored, then lines with leading and trailing whitespace
  ignored, re-indenting new lines to the file's own indentation at the
  third tier. `--strict` allows exact matches only; `--check` reports
  what would change without writing anything.

## The files

- `main.ts` — the whole CLI. Node 22, standard library only, no
  dependencies. Run as `node main.ts [options] [PATCH]` with the working
  directory as the root of the tree.
- `runner.ts` — the kit's trial runner, kept as it is. When
  `MAKEFUN_ENV_URL` is set, `main.ts` hands the run over to it.

## Checks

The kit's practice set and a hand-written edge-case suite both pass in
full on this machine:

    node check.ts ../program/generator/practice.json   # 100 of 100
    node check.ts ../extra.json                       # 57 of 57

(`check.ts` is the kit's practice runner; it is not part of this repo.)
The edge cases cover what the practice set does not show: usage errors,
unreadable patches, undetectable formats, parse errors at each format's
exact line, empty hunks and blocks, CRLF files, files with no final line
break, `\ No newline at end of file` after old and new lines, overlapping
occurrences, move chains, moves onto paths an earlier edit deleted or
created, atomicity across edits, and `--check` with failing edits.
