# Error Log

## 2026-09-10

- **Deleted-file staging**: `isomorphic-git` `git.add` reports a missing file
  when an already-deleted tracked path is staged through the individual Changes
  flow. The isolated `git.remove` path stages the deletion, but the product
  flow remains unfixed and is recorded as follow-up work.
- **Mobile checkout filename**: Force Pull initially failed with nested
  `MultipleGitError` / `FILE_NOTCREATED` for a note whose name contains `?`.
  Error formatting now exposes the nested path and code, and mobile checkout
  skips/report that path so the operation can complete. The user confirmed the
  successful Force Pull result.

## 2026-09-07

- **Stale mobile adapter paths**: Obsidian's index could list a path that had
  already moved or been deleted, producing `ENOENT`/`lstat` failures during Git
  reads. The filesystem bridge now filters missing entries and reuses validated
  stats for the following calls in `da7a4a6`.

## 2026-09-05

- **mb-core integration test**: `mb db test` failed because its workflow test
  expected `database/test_output/` files that the test did not create. The
  fresh SQLite schema and database initialization succeeded. No mb-core source
  was changed.

## 2026-09-06

- **pnpm workspace config**: a generated `pnpm-workspace.yaml` caused pnpm 9
  frozen installs to fail with `packages field missing or empty`; the file was
  removed in `c675818`.
- **Mobile Git runtime**: `Buffer is not defined` occurred when Changes invoked
  `isomorphic-git`; a browser Buffer polyfill was added in `8a90e91`.
