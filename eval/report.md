# LineGrade M1: AI classification accuracy

> **SYNTHETIC DATA.** 60 invented product names (`eval/labels.csv`). Results measure this small synthetic set only; they say nothing about real catalogs.

> Only `LLM_MODEL` was run this time. Sonnet (`LLM_MODEL_STRONG`) was not re-run after the label corrections; its run-1 results, scored against the old labels, are in `eval/report-run1.md`.
- Date: 2026-11-07
- Git commit: c66009c (uncommitted changes)
- Code list: UNSPSC UNv260801 (c) UNDP, subset of 11378 commodity codes, LLM normalisation, keyword shortlist of 40 (raw + rewritten text), then LLM choice (normalisation model: LLM_MODEL_NORMALIZE, else LLM_MODEL)
- Flag (needs_review): confidence < 0.6, no code, or a look-alike runner-up (same 6-digit class, confidence gap < 0.2; classifier version 2)
- Rows: 60, concurrency 5

## Summary (side by side)

| Metric | LLM_MODEL: `anthropic/claude-haiku-5.5` |
|---|---|
| Exact 8-digit, primary code | 100.0% |
| Exact 8-digit, acceptable (primary or alt in notes) | 100.0% |
| Class level (first 6 digits), primary | 100.0% |
| Class level (first 6 digits), acceptable | 100.0% |
| Acceptable exact: 50 normal rows / 10 hard rows | 100.0% / 100.0% |
| Shortlist recall@40 BEFORE normalisation (raw name only, 53 coded rows) | 96.2% (51/53) |
| Shortlist recall@40 AFTER normalisation (raw + rewritten phrase) | 100.0% (53/53) |
| Normalisation calls that failed (fell back to raw only) | 0 |
| UoM valid, Braintree (as returned by model) | 100.0% |
| UoM valid, PayPal (as returned by model) | 100.0% |
| UoM valid after repair (what the app would send) | BT 100.0%, PP 100.0% |
| UoM equals label, Braintree / PayPal (56 rows with a label) | 100.0% / 100.0% |
| Flagged share, confidence rule only (< 0.6 or no code) | 11.7% (7/60) |
| Flagged share, + look-alike rule (used for targets) | 11.7% (7/60) |
| Wrong answers left unflagged: confidence rule only / + look-alike rule | 0 / 0 |
| Accuracy of unflagged rows (acceptable): confidence rule only / + look-alike rule | 100.0% / 100.0% |
| Accuracy on unflagged rows: exact primary | 100.0% (n=53) |
| Accuracy on unflagged rows: exact acceptable | 100.0% |
| Accuracy on unflagged rows: class level primary | 100.0% |
| Wrong answers with confidence > 0.85 | 0 |
| Cost, 60 rows (normalise + classify calls) | $0.0254 |
| Cost per row | $0.00042 |
| Tokens in / out | 144662 / 21957 |
| Time, 60 rows (wall clock) | 44 s |
| Failed calls / description fallbacks | 0 / 0 |

## Targets

| Target | LLM_MODEL |
|---|---|
| Class level (primary) >= 80% | PASS |
| UoM valid 100% for both processors (as returned) | PASS |
| No wrong answer with confidence > 0.85 | PASS |
| Flagged rows <= 25% | PASS |

Definitions: *primary* = `expected_unspsc`; *acceptable* also counts the `alt` code written in the notes. A row labelled `NONE` counts as correct if the classifier returns no code or flags the row (confidence < 0.6). "Wrong" for the confidence check means not acceptable at 8 digits. UoM validity is checked against the allowed Braintree set (EA, BX, PK, CS, LB, KG, LTR) and the PayPal tested set (EACH, BOX, PACK, CASE, UNIT, POUND, KILOGRAM, LITER, KGM, LTR, ITM).

## Look-alike rule: effect on this eval

The model also returns a runner-up code with its own confidence. A row becomes `needs_review` when the runner-up is in the same 6-digit class and the gap is under 0.2. The rule is general and was not tuned per row. Both flag counts below come from the same run, so they differ only by the rule. The prompt also changed (it now asks for the runner-up), so this run is not directly comparable with earlier ones.

**LLM_MODEL**: the rule flagged 0 extra row(s) beyond the confidence rule (11.7% -> 11.7% flagged); wrong answers left unflagged: 0 -> 0.

## Label corrections after run 1

Run 1 (`eval/report-run1.md`) showed the models choosing a more specific commodity than the label for three rows. The labels were corrected; the old code stays as an alternate (`alt` in notes). No other label was changed.

| SKU | Raw name | Old code (now alternate) | New code (primary) | Reason |
|---|---|---|---|---|
| SYN-022 | 3-ring binder 1.5in white vw | 44122003 Binders | 44122037 Ring binder | The label was a broader code in the same class; the official title matches the product exactly. |
| SYN-046 | Claw hammer 16oz fiberglass hdl | 27111602 Hammers | 27111618 Claw hammer | The label was a broader code in the same class; the official title matches the product exactly. |
| SYN-051 | N95 resp mask NIOSH 20/bx | 46182002 Respirators | 46182010 Respiratory mask FFP2/N95 | The label was a broader code in the same class; the official title matches the product exactly. |

The correction was made after seeing run-1 results, so it favours the model on those three rows. Scores for runs 1 and 2 are not directly comparable.

## Shortlist recall@40 history (53 coded rows)

| Run | Matching rules | Raw name only | Raw + rewritten phrase |
|---|---|---|---|
| 1 | keyword v1 (exact, prefix, typo, abbreviation) | 94.3% (50/53) | 96.2% (51/53) |
| 2 (this report) | keyword v2 (v1 + word-family stems, compound words) | 96.2% (51/53) | 100.0% (53/53) |

Disclosure: the run-1 normalisation prompt contained three example rewrites taken from labelled rows (SYN-001, SYN-015, SYN-020). They were replaced with non-evaluation examples before run 2, so run-1 recall after normalisation is slightly optimistic. The v2 matching rules are general (stems, joined words); none refer to specific rows.

## Wrong answers: LLM_MODEL (`anthropic/claude-haiku-5.5`), 0 of 60

None.

## Rows that matched only the alternative code (acceptable but not exact)

- LLM_MODEL: none
