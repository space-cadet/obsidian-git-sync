# T5: Activity and Logging

*Last Updated: 2026-09-10 04:05:00 IST*

## Purpose

Explain recent plugin actions in a simple Activity view.

## Initial scope

- Activity list
- Operation success and failure messages
- Small persisted history
- Clear and export actions

## Implemented state

The Log tab reads plain-text entries from the plugin-owned `activity.log`.
Each entry stores a message, timestamp, and severity level (`DEBUG`, `INFO`,
`METRIC`, or `ERROR`). Writes are serialized and compacted to the latest 1,000
entries after a bounded append threshold; plugin-data export can include a
separate bounded Activity snapshot when explicitly enabled.
The view renders full date/time stamps, severity badges, alternating rows, and
wrapped messages inside the scrollable content area. Writes are serialized so
activity and settings updates do not overwrite one another.

The Log tab shows the 100 most recent messages initially and supports loading
older pages. Log text is selectable for copying. Repository refreshes include
timings for inspection, Changes, local commits, and remote commits, along with
result counts; stage, unstage, commit, targeted refresh, and remote operations
record elapsed-time entries. Tab-switch metrics and the avoidable Push
working-tree scan were removed.

## KISS boundary

Use one straightforward log source. Do not add a general event system,
multi-level retention policy, or analytics layer without a demonstrated need.

## Completion evidence

The user verified the pushed build and confirmed that Log entries persist and
render correctly, including remote-operation diagnostics and Git-style result
details. Clear and a dedicated Log export action remain outside the current
scope.

Remote failures now preserve nested Git details instead of only the outer
`MultipleGitError` label. The diagnostic output includes the underlying code,
caller, and exact filesystem path when available, which made the mobile
`FILE_NOTCREATED` failure actionable.
