# Session 11: Archive Size Optimization

Reduce archive size without silently damaging fidelity.

## Objective

Reduce archive size with deterministic deduplication, ZIP compression, size estimates, and explicit large-media choices.

## Required Work

1. Deduplicate identical bodies by SHA-256 while preserving URL aliases.
2. Report logical bytes versus physical archive bytes saved.
3. Exclude source maps by default and let the user include or skip large video/audio with a clear size estimate.
4. Estimate archive size before final ZIP generation.
5. Warn before crossing configurable size limits.
6. Make exclusions visible in report and manifest.
7. Validate the resulting archive after optimization.
8. Do not add tracker inference, responsive-image pruning, font pruning, or multiple capture profiles.

## Acceptance Criteria

- Duplicate fixture bodies are stored once without broken aliases.
- Compression and deduplication materially reduce duplicate-heavy fixtures without route or required-asset regressions.
- Skipped large media is clearly reported and user-controlled.
- Size estimates are within an agreed error margin.
- Optimized archives pass hermetic replay and post-export validation.

## Verification

Add duplicate body, ZIP compression, media exclusion, size estimate, warning-threshold, and replay regression tests.
