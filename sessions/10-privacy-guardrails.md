# Session 10: Privacy Guardrails

Protect ordinary users from accidentally sharing secrets or personal data in captured websites.

## Objective

Prevent credentials and sensitive form values from leaking through capture metadata, reports, and logs, and clearly label archives as private by default.

## Required Detection Classes

- authorization headers, bearer tokens, API keys, JWT-like values
- session identifiers and cookie values
- password/payment/file input values
- query parameters and POST bodies likely to contain secrets

## Required Behavior

- Scan locally only.
- Sanitize metadata, reports, logs, request headers, and captured form state by default.
- Never print full secrets in logs or reports.
- Show category, location, confidence, and masked preview.
- Allow exclusion or cancellation when a risky artifact cannot be sanitized safely.
- Record redaction actions in manifest without storing removed values.
- Treat runnable body content as private evidence; do not rewrite arbitrary HTML, JSON, or JavaScript bodies with broad PII patterns.
- Do not claim an archive is safe to share merely because metadata passed scanning.

## Constraints

- No cloud secret-scanning service.
- Do not alter runnable output blindly when redaction would break required application behavior; explain the tradeoff.

## Acceptance Criteria

- Seeded secrets in headers, URLs, request metadata, logs, reports, and captured form state are detected.
- Default metadata, reports, logs, and live form snapshots contain none of the seeded secret values.
- Masking never reveals enough characters to reconstruct a token.
- Redaction failures produce a clear private-data warning and can cancel export.
- Scanner performance is measured on large captures.

## Verification

Add credentials/header/URL/form positives, harmless lookalike negatives, masking, cancellation, large-capture, and regression tests using synthetic secrets only.
