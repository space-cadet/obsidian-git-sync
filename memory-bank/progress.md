# Progress

## 2026-09-05

- Archived the previous Memory Bank.
- Initialized a fresh Memory Bank and SQLite database with mb-core.
- Registered the component-based task tree.
- Started the fresh session with T1 and T2 active.

## 2026-09-06

- Built and published the sidebar shell, Settings entry point, and read-only
  local repository state.
- Added the visible Activity tab with in-memory operation messages.
- Added the branch-aware updater and GitHub branch development releases.
- Passed local TypeScript, production-build, and whitespace checks and the
  related GitHub build-and-release workflows.
- Implemented the local Changes workflow with stage/unstage and commit actions;
  pnpm 9 frozen install/build and a Bufferless Git integration check passed.
- Corrected rolling branch-build ordering and timestamps to use `updated_at`;
  mobile Changes rendering was observed after the Buffer polyfill fix.
- Completed the verified Changes and Log UI increments, Settings auto-save and
  token visibility, and the first remote connection/authentication increment.
- User verified the pushed Changes and Log behavior, including preserved scroll
  position after staging updates.
- Added and pushed the Git-style progress modal with elapsed time, retained
  completion/failure state, remote diagnostics, and Activity logging.
- Added operation-specific Fetch, Pull, Push, and Clone results, including
  no-op detection, ref updates, commit/file counts, and uncommitted-file warnings.
- Polished mobile behavior with scrollable modal output, subdued animation, and
  Changes refreshes that preserve the tab shell and scroll position.

## 2026-09-07

- Added Changes multi-selection, per-section filtering/sorting, file overflow
  actions, and targeted staging/commit/gitignore reconciliation.
- Added paginated Local/Remote history with lazy changed-file details and
  paginated plain-text Activity backed by `activity.log`.
- Deferred full Changes scans to initial/context/manual Refresh paths and made
  uncertain post-Pull/Clone state explicit.
- Added stale-path filtering and validated-stat reuse in the filesystem bridge.
- Recorded latency instrumentation, tuning commits, evidence boundaries, and
  the remaining controlled large-vault benchmark plan.
- Final production build and `git diff --check` passed; branch parity is
  `574633a` locally and on `origin/codex/kiss-restart`.

## 2026-09-10

- Promoted the from-scratch rewrite to `main` and preserved the former main
  line as `main-before-kiss-restart`; the redundant `codex/kiss-restart` branch
  was removed after the rewrite became the main line.
- Corrected the development-build workflow so pushes to `main` publish a
  rolling `latest-dev-main` build; the correction was pushed in `97210c3`.
- Added confirmed Force Pull and Force Push actions beside the normal remote
  actions, with distinct icons, muted-red styling, and confirmation modals.
- Improved nested remote error reporting and adapter path diagnostics after
  mobile exposed `MultipleGitError` and `FILE_NOTCREATED` failures.
- Changed Pull and Force Pull checkout to skip mobile-incompatible filenames
  while reporting each skipped path. The user confirmed mobile Force Pull
  completed at `f0201a9`; desktop Force Push also reached the remote.
- Current local and remote main parity is `f67860e`.

## Next

- Implement cancellation only if the HTTP bridge supports a real abort path.
- Keep T4 revert and T5 clear/export as remaining refinements.
- Capture controlled cold/warm large-vault timings and continue remote edge-case
  and platform-specific T10 acceptance.
- Record platform-specific T10 acceptance when those hosts are tested.

## 2026-09-06 Session Closeout

- Completed versioned plugin-data export/import with optional Activity history.
- Completed local and fetched Remote Commits display with comparison status.
- Completed Changes-toolbar Pull, Push, and Fetch wiring with live diagnostics.
- Fixed Pull author identity and Push HTTP-body transport failures.
- The user verified the pushed Remote commits view and confirmed Pull and Push work.
