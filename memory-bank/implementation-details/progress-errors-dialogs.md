# T8: Progress, Errors, and Dialogs

*Last Updated: 2026-09-10 04:05:00 IST*

## Purpose

Make active operations and failures understandable without adding a framework.

## Approved mockup

The approved visual reference is [`progress-modal-mockup.png`](../assets/progress-modal-mockup.png).
It shows a centered Git-like operation dialog with a phase label, phase-local
progress, remote output, and a disabled Close action while the operation is
active.

## Initial scope

- Operation progress
- Cancel action where supported
- Confirmation dialog for destructive actions
- Error display with an actionable message

## KISS boundary

Show only phases and values the underlying operation actually provides. Do not
invent transfer metrics or add generic workflow orchestration.

## Completion evidence

The user can tell what is happening, stop a supported operation, and understand
what to do after a failure.

## Implemented state

- Fetch, Pull, Push, and Clone now forward `onProgress` and `onMessage` from
  `isomorphic-git` into the operation modal.
- The modal displays the current library-provided phase, a determinate
  phase-local count when `total > 0`, and an indeterminate working state when a
  total is unavailable.
- The modal shows a `Time elapsed: mm:ss` counter while active and freezes the
  final elapsed time when the operation finishes.
- Completion and failure leave the modal open. The Close button is enabled only
  after either state is reached, and the user closes the modal explicitly.
- Phase transitions and sanitized remote messages are recorded in Activity;
  individual percentage updates are not persisted as separate rows.
- Fetch, Pull, Push, and Clone now return operation-specific result summaries.
  The modal distinguishes `Already up to date.` / `Everything up-to-date.` from
  an actual ref update and shows the relevant short object IDs, commit/file
  counts where available, and uncommitted files that a push cannot include.
- The modal also includes a short operation-specific explanation, a compact
  Git-style result transcript, and a restrained animated progress accent. The
  remote and result fields are vertically scrollable on small screens, and the
  accent respects reduced-motion preferences.
- Destructive `git rm` actions use a confirmation modal. Cancellation remains
  intentionally absent until the HTTP bridge and Git operation expose a tested
  abort path.
- Remote confirmation modals distinguish the destructive operations as “Reset
  to Remote” for Force Pull and “Force Push” for Force Push.
- Error formatting recursively walks nested `errors` arrays, preserving the
  useful Git code, caller, and underlying message instead of showing only a
  generic `MultipleGitError`. DataAdapter write/remove/mkdir/rmdir failures
  include the path that could not be handled.
- A mobile Force Pull can finish successfully while reporting skipped paths
  that contain unsupported filename characters; the final result keeps that
  warning visible.

## Git CLI behavior to reproduce

The canonical Git CLI presents remote operations as two different kinds of
output:

1. Transient progress written to stderr while the operation is running.
2. Permanent, human-readable result lines written after refs or the working
   tree have been updated.

Progress is normally enabled when stderr is attached to a terminal. `--progress`
forces it when stderr is redirected, while `--quiet` suppresses it. Terminal
progress commonly rewrites the current line with carriage returns; it should
not be stored as one permanent Activity row per percentage update.

Git's smart transport separates pack data, progress messages, and fatal remote
errors. Remote progress is conventionally shown with a `remote:` prefix.
References:

- [git-clone](https://git-scm.com/docs/git-clone)
- [git-fetch](https://git-scm.com/docs/git-fetch)
- [git-pull](https://git-scm.com/docs/git-pull)
- [git-push](https://git-scm.com/docs/git-push)
- [Git protocol side-band capabilities](https://git-scm.com/docs/protocol-capabilities.html)
- [Git sideband implementation](https://github.com/git/git/blob/master/sideband.c)

### Clone

The usual sequence is:

```text
Cloning into 'repo'...
remote: Counting objects: 1857, done.
remote: Compressing objects: 100% (93/93), done.
remote: Total 1857 (delta 0), reused 0
Receiving objects: 100% (1857/1857), 374.35 KiB | 268.00 KiB/s, done.
Resolving deltas: 100% (772/772), done.
Checking connectivity... done.
```

`remote:` lines are server messages. `Receiving objects`, `Resolving deltas`,
and `Checking connectivity` describe local client work. Clone is a compound
operation: fetch/index-pack followed by checkout, so one overall percentage is
not a reliable representation of the whole operation.

### Fetch

Fetch combines transfer progress with a permanent remote-ref summary:

```text
remote: Counting objects: ...
remote: Compressing objects: ...
remote: Total ...
Receiving objects: ...
Resolving deltas: ...
From https://example.com/repo.git
   abc1234..def5678  main -> origin/main
```

The documented human-readable ref form is:

```text
<flag> <summary> <from> -> <to> [<reason>]
```

Up-to-date refs are normally omitted unless verbose output is requested.
`--porcelain` provides a stable machine-readable form on stdout.

### Pull

Pull first performs fetch and then integrates the fetched branch. The visible
output therefore contains fetch progress followed by an integration result:

```text
Updating abc1234..def5678
Fast-forward
 file.md | 4 +++-
 1 file changed, 3 insertions(+), 1 deletion(-)
```

The no-change result is:

```text
Already up to date.
```

For fast-forward-only behavior, divergence is a result that needs an explicit
failure explanation rather than an invented merge progress phase.

### Push

Push reports local pack creation, remote messages, and then one permanent ref
result:

```text
Counting objects: 14, done.
Delta compression using up to 8 threads.
Compressing objects: 100% (12/12), done.
Writing objects: 100% (14/14), 2.05 KiB | 0 bytes/s, done.
Total 14 (delta 3), reused 0
To git@example.com:repo.git
 * [new branch]      main -> main
```

Push ref-result flags have stable meanings:

| Flag | Meaning |
| --- | --- |
| ` ` | Successful fast-forward |
| `*` | New ref pushed |
| `+` | Forced update |
| `-` | Ref deleted |
| `=` | Ref was already up to date |
| `!` | Ref rejected or failed |

For a failure, Git identifies the ref and reason, for example a non-fast-
forward rejection or a remote hook rejection. A generic `Push failed` message
loses useful information that the CLI preserves.

### Local status and merge results

`git status` is a snapshot rather than a progress operation. Its branch summary
can include ahead/behind counts, and porcelain v2 exposes them as:

```text
# branch.ab +2 -1
```

Merge output similarly reports a final state (`Fast-forward`, `Already up to
date`, or a conflict) rather than pretending that the merge has a measurable
percentage.

## Fit with the current implementation

The checkout currently uses `isomorphic-git` 1.41.9. Its `clone`, `fetch`,
`pull`, and `push` APIs expose:

```ts
type GitProgressEvent = {
  phase: string;
  loaded: number;
  total: number;
};
```

They also accept `onMessage` for messages generated by the remote server. The
library warns that progress events may not be ordered or monotonically
increasing, and that compound commands such as clone contain multiple phases.
The UI must therefore treat `phase` as authoritative, clamp or ignore stale
values, and only show a determinate bar when the current event has a meaningful
`total`.

The installed library currently emits phases including `Receiving objects`,
`Resolving deltas`, `Updating workdir`, and `Analyzing workdir`. The exact set
depends on the command and whether it has objects or working-tree files to
process; the UI must render the supplied phase text rather than assume every
CLI phase will occur.

The wrappers in `src/remote.ts` pass `onProgress` and `onMessage` through and
return operation-specific result summaries. Push also captures the library's
pre-push local/remote object IDs, so the UI can distinguish a no-op from a ref
update and can explain when uncommitted files were not part of the push. The
current Obsidian HTTP bridge still buffers the request and response through
`requestUrl`; its `onProgress` and `AbortSignal` fields are not wired to a
byte-progress or cancellation path.

## Modal feasibility

The modal can precisely mimic the *visible semantics* of the Git CLI:

- operation title: `Fetching origin/main`
- current phase: `Receiving objects`, `Resolving deltas`, or another phase
  supplied by the library
- phase-local count and percentage when `total > 0`
- indeterminate spinner when no meaningful total exists
- separate remote-message/detail text
- permanent final result modeled on Git's ref or merge summary
- explicit error state with the Git error code, affected ref, and next action

It cannot precisely mimic the terminal itself in every respect:

- a sidebar modal cannot reproduce terminal carriage-return repainting exactly;
- one overall percentage across clone or pull would be misleading;
- HTTP byte-level upload/download progress is not currently exposed by the
  bridge;
- cancellation cannot honestly be offered until the HTTP request and Git
  operation accept and honor an abort signal.

The appropriate T8 target is therefore a Git-like modal, not a terminal
emulator: preserve Git's phase names, remote-message distinction, result
symbols, and failure reasons while using normal accessible modal controls.

## Implementation direction

1. Add progress and message callbacks to the remote operation options.
2. Forward those callbacks from `src/remote.ts` for Fetch, Pull, Push, and
   Clone.
3. Keep one live operation state in the existing queued operation path in
   `src/main.ts`.
4. Render phase-local progress in the modal and throttle display updates; do
   not write every callback to persistent Activity.
5. Derive final Fetch/Push results from returned refs and before/after heads.
   Pull currently returns no detailed result, so its final summary needs a
   before/after ref comparison or a clear `Fast-forward completed`/
   `Already up to date` classification.
6. Do not add a Cancel button until abort behavior is implemented and tested.

References for the library behavior:

- [`isomorphic-git` progress events](https://isomorphic-git.org/docs/en/onProgress)
- [`isomorphic-git` remote messages](https://isomorphic-git.org/docs/en/onMessage)
- [`isomorphic-git` fetch](https://isomorphic-git.org/docs/en/fetch)
- [`isomorphic-git` pull](https://isomorphic-git.org/docs/en/pull)
- [`isomorphic-git` push](https://isomorphic-git.org/docs/en/push.html)
- [`isomorphic-git` clone](https://isomorphic-git.org/docs/en/clone)
- [`isomorphic-git` HTTP client](https://isomorphic-git.org/docs/en/next/http)
