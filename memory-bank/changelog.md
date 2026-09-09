# Changelog

## 2026-09-10

- Promoted the from-scratch rewrite to `main` and preserved the former main
  line as `main-before-kiss-restart`; removed the redundant delivery branch. - T10
- Published main development builds through Browse Builds. - T9
- Added confirmed Force Pull and Force Push actions with distinct muted-red
  icon controls. - T7, T8
- Added recursive nested Git error details and exact DataAdapter failure paths.
  - T7, T8
- Skipped and reported mobile-incompatible checkout paths so Pull and Force
  Pull can complete on mobile; user verification confirmed the behavior. - T7, T10

## 2026-09-07

- Added the latency investigation and tuning record with commit-level evidence,
  explicit refresh policy, verification limits, and a large-vault benchmark plan. - T4, T5, T6, T7, T10
- Added Changes multi-selection, per-section filtering/sorting, file overflow
  actions, and targeted mutation reconciliation. - T4
- Added plain-text Activity persistence, bounded compaction, selectable 100-message
  pages, phase timings, and removed noisy tab/Push scans. - T5
- Added lazy commit details and independent 100-commit Local/Remote pagination. - T6
- Added retained remote phase/result diagnostics and manual Changes refresh states. - T7, T8
- Recorded stale-path filtering and validated-stat reuse for mobile adapter reads. - T3, T4
- Recorded final build, diff, parity, and remaining large-vault/host acceptance gaps. - T10

## 2026-09-06

- Added the Git Sync sidebar shell, repository states, Activity tab, and
  sidebar Open Settings action. - T1, T2, T3, T5
- Added stable/development update discovery, build browsing, transactional
  installation, rollback, and branch development releases. - T9, INFRA
- Recorded local and GitHub build evidence; real-host install/reload checks
  remain open. - T10
- Added the local Changes workflow, including DataAdapter-backed status,
  stage/unstage, commit, and mobile Buffer support. - T4, T10
- Corrected rolling branch-build ordering and timestamp display to use release
  `updated_at`. - T9
- Added Settings auto-save and secure token visibility controls. - T2
- Added the target Changes layout and render-preserving staging updates. - T4
- Added persistent structured Log entries with full timestamps and severity. - T5
- Added the initial remote connection and credential foundation. - T7
- Recorded user verification of the pushed Changes and Log behavior. - T10
- Added versioned plugin-data export/import with optional Activity history. - T2
- Added Local/Remote Commits history and repository comparison states. - T6
- Added Fetch, Pull, Push, and Clone transport flows with queued diagnostics. - T7
- Moved Pull, Push, and Fetch to the Changes toolbar and removed duplicate
  Settings operation controls. - T4
- Fixed Pull author identity and Push request-body handling after user Log
  evidence; the user confirmed both toolbar actions now work. - T5, T7
- Added Git-style progress modals for Fetch, Pull, Push, and Clone with elapsed
  time, retained final state, remote messages, and Activity logging. - T5, T7, T8
- Added operation-specific no-op/ref-update results, commit/file counts, and
  warnings for uncommitted files excluded from Push. - T7, T8
- Added scrollable modal output, subdued progress animation, and in-place
  Changes refreshes that preserve mobile scroll position. - T4, T8

## 2026-09-05

- Started the clean component-based rebuild of Obsidian Git.
- Added the UI shell and Settings panel as the first implementation tasks.
- Archived the previous implementation records outside the fresh Memory Bank.
