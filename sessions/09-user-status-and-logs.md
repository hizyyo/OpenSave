# Session 09: User-Facing Status And Logs

Replace the current technical stream with a result ordinary users can understand.

## Objective

Show what openSave is doing, what it saved, what was intentionally ignored, and whether the result works.

## Required Normal-Mode Stages

- Preparing the page
- Discovering pages and files
- Saving pages
- Saving images, fonts, media, and application data
- Building the copy
- Checking the result
- Ready, partial, failed, or cancelled

## Required Result Summary

Use concrete language such as:

```text
Saved 8 of 8 pages
Saved 142 of 145 required files
3 analytics requests were ignored
All saved pages opened successfully
The copy is ready
```

Separate:

- required content missing
- optional media skipped by settings
- analytics/tracker failures
- API/state limitations
- validation failures
- technical diagnostics

## Implementation Requirements

- Define typed progress and diagnostic codes; do not build UI meaning by parsing strings.
- Group duplicate errors.
- Show one recommended action for each user-actionable failure.
- Keep a collapsed details panel.
- Keep machine-readable diagnostics in the archive for bug reports, without adding a Developer Mode UI.
- Never report "complete" before post-export validation succeeds.
- Include saved HTML page count and tested route count.

## Acceptance Criteria

- User tests can correctly explain success, partial success, and failure without opening technical details.
- Analytics failures do not look like missing site content.
- Required missing assets cannot be hidden by a high aggregate score.
- Progress does not move backwards unless explicitly entering validation/retry.
- Cancellation and recovery states are clear.
- Machine-readable JSON remains sufficient for bug reports.

## Verification

Add snapshot/accessibility tests for success, partial, failure, cancellation, recovery, privacy warning, size warning, and collapsed detail views.
