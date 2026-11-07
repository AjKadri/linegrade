# LineGrade M1: AI classification accuracy

> **SYNTHETIC DATA.** 60 invented product names (`eval/labels.csv`). Results measure this small synthetic set only; they say nothing about real catalogs.

- Date: 2026-11-07
- Git commit: n/a (not a git repository or no commits yet)
- Code list: UNSPSC UNv260801 (c) UNDP, subset of 11378 commodity codes, LLM normalisation, keyword shortlist of 40 (raw + rewritten text), then LLM choice (normalisation model: LLM_MODEL_NORMALIZE, else LLM_MODEL)
- Flag threshold: confidence < 0.6 (or no code returned)
- Rows: 60, concurrency 5

## Summary (side by side)

| Metric | LLM_MODEL: `anthropic/claude-haiku-5.5` | LLM_MODEL_STRONG: `anthropic/claude-sonnet-5.5` |
|---|---|---|
| Exact 8-digit, primary code | 90.0% | 91.7% |
| Exact 8-digit, acceptable (primary or alt in notes) | 90.0% | 91.7% |
| Class level (first 6 digits), primary | 96.7% | 98.3% |
| Class level (first 6 digits), acceptable | 96.7% | 98.3% |
| Acceptable exact: 50 normal rows / 10 hard rows | 90.0% / 90.0% | 92.0% / 90.0% |
| Shortlist recall@40 BEFORE normalisation (raw name only, 53 coded rows) | 94.3% (50/53) | 94.3% (50/53) |
| Shortlist recall@40 AFTER normalisation (raw + rewritten phrase) | 96.2% (51/53) | 96.2% (51/53) |
| Normalisation calls that failed (fell back to raw only) | 0 | 0 |
| UoM valid, Braintree (as returned by model) | 100.0% | 100.0% |
| UoM valid, PayPal (as returned by model) | 100.0% | 100.0% |
| UoM valid after repair (what the app would send) | BT 100.0%, PP 100.0% | BT 100.0%, PP 100.0% |
| UoM equals label, Braintree / PayPal (56 rows with a label) | 100.0% / 100.0% | 100.0% / 100.0% |
| Flagged share (confidence < 0.6 or no code) | 13.3% (8/60) | 13.3% (8/60) |
| Accuracy on unflagged rows: exact primary | 90.4% (n=52) | 92.3% (n=52) |
| Accuracy on unflagged rows: exact acceptable | 90.4% | 92.3% |
| Accuracy on unflagged rows: class level primary | 98.1% | 100.0% |
| Wrong answers with confidence > 0.85 | 3 | 3 |
| Cost, 60 rows (normalise + classify calls) | $0.0219 | $0.3177 |
| Cost per row | $0.00036 | $0.00530 |
| Tokens in / out | 134318 / 16879 | 134318 / 9593 |
| Time, 60 rows (wall clock) | 38 s | 41 s |
| Failed calls / description fallbacks | 0 / 0 | 0 / 0 |

## Targets

| Target | LLM_MODEL | LLM_MODEL_STRONG |
|---|---|---|
| Class level (primary) >= 80% | PASS | PASS |
| UoM valid 100% for both processors (as returned) | PASS | PASS |
| No wrong answer with confidence > 0.85 | FAIL | FAIL |
| Flagged rows <= 25% | PASS | PASS |

Definitions: *primary* = `expected_unspsc`; *acceptable* also counts the `alt` code written in the notes. A row labelled `NONE` counts as correct if the classifier returns no code or flags the row (confidence < 0.6). "Wrong" for the confidence check means not acceptable at 8 digits. UoM validity is checked against the allowed Braintree set (EA, BX, PK, CS, LB, KG, LTR) and the PayPal tested set (EACH, BOX, PACK, CASE, UNIT, POUND, KILOGRAM, LITER, KGM, LTR, ITM).

## Wrong answers: LLM_MODEL (`anthropic/claude-haiku-5.5`), 6 of 60

| SKU | Raw name | Rewritten | Expected | Got | Conf | Class ok | In shortlist before / after | Reason (model) |
|---|---|---|---|---|---|---|---|---|
| SYN-015 | Copy ppr 8.5x11 20lb cs/10 | copy paper | 14111507 | 14111525 Multipurpose paper | 0.75 | yes | NO / NO | Standard 8.5x11 20lb copy paper is multipurpose office paper; the case pack indicates it is sold by the case (CS). |
| SYN-016 | Ballpt pens blk med 12/bx | ballpoint pens | 44121704 | null | 0.2 | no | NO / NO | The line is finished ballpoint pens, and the only pen-related shortlist code is for ink refills, which is a different product. |
| SYN-022 | 3-ring binder 1.5in white vw | ring binders | 44122003 | 44122037 Ring binder | 0.93 | yes | yes / yes | A 3-ring binder is a ring binder, which matches 44122037 directly; the 'vw' suffix is not a spec I can confirm, so it is left out. |
| SYN-039 | Fire extinguisher ABC 10lb wall brkt | fire extinguisher | 46191601 | 31162506 Wall mount bracket | 0.6 | no | yes / yes | The name ends in 'wall brkt', so the line is the mounting bracket for the extinguisher, not the extinguisher itself. Confidence is moderate because the name could also be read as the extinguisher. |
| SYN-046 | Claw hammer 16oz fiberglass hdl | claw hammer | 27111602 | 27111618 Claw hammer | 0.95 | yes | yes / yes | The name directly describes a claw hammer, which matches shortlist code 27111618; it is sold as a single tool. |
| SYN-051 | N95 resp mask NIOSH 20/bx | N95 respirator masks | 46182002 | 46182010 Respiratory mask FFP2/N95 | 0.9 | yes | yes / yes | N95 particulate respirators map to the FFP2/N95 respiratory mask code; the 20/bx pack size means it is sold by the box. |

## Wrong answers: LLM_MODEL_STRONG (`anthropic/claude-sonnet-5.5`), 5 of 60

| SKU | Raw name | Rewritten | Expected | Got | Conf | Class ok | In shortlist before / after | Reason (model) |
|---|---|---|---|---|---|---|---|---|
| SYN-015 | Copy ppr 8.5x11 20lb cs/10 | copy paper | 14111507 | 14111525 Multipurpose paper | 0.9 | yes | NO / NO | Copy paper 8.5x11 20lb is standard multipurpose paper; sold by the case of 10. |
| SYN-016 | Ballpt pens blk med 12/bx | ballpoint pens | 44121704 | null | 0.15 | no | NO / NO | The shortlist has no ballpoint pen code; the only close entry is ink refills, which is a different product, so null is safer. |
| SYN-022 | 3-ring binder 1.5in white vw | ring binders | 44122003 | 44122037 Ring binder | 0.8 | yes | yes / yes | A 3-ring binder matches 'Ring binder' most directly; 'Binders' is a plausible but more generic alternative. |
| SYN-046 | Claw hammer 16oz fiberglass hdl | claw hammer | 27111602 | 27111618 Claw hammer | 0.93 | yes | yes / yes | Product is explicitly a claw hammer, which matches the 'Claw hammer' commodity code exactly; sold as a single tool. |
| SYN-051 | N95 resp mask NIOSH 20/bx | N95 respirator masks | 46182002 | 46182010 Respiratory mask FFP2/N95 | 0.9 | yes | yes / yes | N95 NIOSH respirator mask matches the 'Respiratory mask FFP2/N95' code directly; sold 20 per box. |

## Rows that matched only the alternative code (acceptable but not exact)

- LLM_MODEL: none
- LLM_MODEL_STRONG: none
