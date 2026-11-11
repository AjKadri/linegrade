# LineGrade frozen holdout: result (single run)

> **SYNTHETIC DATA.** 30 invented product names (`eval/holdout/catalog.csv`), written before any holdout run and never used to tune the classifier. Labels (`labels-proposed.csv`) were proposed by the assistant and verified by the user before the run. Codes only: official UNSPSC titles are UNDP copyright and are not in this file. 30 rows is a small sample: read every percentage with that in mind.

| Item | Value |
|---|---|
| Run timestamp (UTC) | results written 2026-11-11T12:48:29Z (run took ~24 s) |
| Repo commit at run | 841e4ef |
| Classifier freeze | `acf8af7`; `src/classify.js` blob `5ae41f7bb202228499d601646dec904a6df05402` and the local code-list sha256 matched `FROZEN.md` immediately before the run |
| Model | `anthropic/claude-haiku-5.5`, temperature 0, seed 42 (best effort), normalisation with the same model |
| Runs | 1 (no re-runs, no changes after seeing results) |
| Cost | $0.0131 (73986 tokens in, 11457 out), 24 s wall clock |

## Numbers

| Metric | Result |
|---|---|
| n | 30 (24 coded rows, 6 NONE rows) |
| Exact 8-digit, primary code | 86.7% (26/30) |
| Accepted (primary or alt code) | 90.0% (27/30) |
| Class level (first 6 digits), primary | 96.7% (29/30) |
| Class level, accepted | 100.0% (30/30) |
| Flagged for review (confidence < 0.6, no code, or look-alike) | 23.3% (7/30) |
| Confident-wrong (not accepted, confidence > 0.85) | 1 |
| Wrong and NOT flagged (any confidence) | 3 |
| NONE rows handled (no code returned or flagged) | 6/6 |
| UoM equals label, Braintree / PayPal | 96.7% (29/30) / 96.7% (29/30) |
| UoM valid as returned, Braintree / PayPal | 100% / 100% |
| Shortlist recall@40 (coded rows): raw name only / raw + rewrite | 21/24 / 22/24 |

Scoring is the same code as the tuned-set harness (`eval/run.js`; only a `--labels` option was added). A NONE row counts as correct if the classifier returns no code or flags it.

## Misses (3): not the expected code or an alt

| SKU | Raw name | Classifier code | Confidence | Runner-up (conf) | Expected | Flagged | Class ok |
|---|---|---|---|---|---|---|---|
| HOL-004 | Readers +1.75 blk frame 6/dsp | 42142929 | 0.6 | 42142903 (0.3) | 42142901 | no | yes |
| HOL-018 | Hi-vis vest class 2 lime XL mesh | 46181555 | 0.82 | 46181507 (0.15) | 46181507 | no | yes |
| HOL-024 | Plotter paper 36in x 150ft 20lb 2rl | 14111510 | 0.93 | - | 14111545 | no | yes |

## Accepted only through an alt code (1)

| SKU | Raw name | Classifier code | Confidence | Expected | Flagged |
|---|---|---|---|---|---|
| HOL-005 | ASTM L2 procedure mask earloop blu 50/bx | 42131620 | 0.55 | 42131713 (alt 42131620) | yes |

## Every flagged row (7)

| SKU | Raw name | Classifier code | Confidence | Expected | Review reasons | Verdict |
|---|---|---|---|---|---|---|
| HOL-005 | ASTM L2 procedure mask earloop blu 50/bx | 42131620 | 0.55 | 42131713 (alt 42131620) | low_confidence | flag not needed (code was acceptable) |
| HOL-025 | Assorted hand tools bulk lot | null | 0.1 | NONE | no_code | NONE row, flag correct |
| HOL-026 | Item 4471 repl part | null | 0.1 | NONE | no_code | NONE row, flag correct |
| HOL-027 | Univ cable kit | null | 0.2 | NONE | no_code | NONE row, flag correct |
| HOL-028 | Fuel surcharge 6.5% | null | 0.03 | NONE | no_code | NONE row, flag correct |
| HOL-029 | Onsite install labor 3hr | null | 0.1 | NONE | no_code | NONE row, flag correct |
| HOL-030 | Annual maint contract renewal | null | 0.05 | NONE | no_code | NONE row, flag correct |

## Rows with a UoM different from the label

| SKU | Raw name | Got BT/PP | Expected BT/PP |
|---|---|---|---|
| HOL-027 | Univ cable kit | PK/PACK | EA/EACH |

## Look-alike pairs (tagged in `labels-proposed.csv` notes)

| Pair | SKU: classifier code (conf), accepted? |
|---|---|
| pair-A gloves | HOL-001: 42132203 (0.85) ok; HOL-002: 42132205 (0.9) ok |
| pair-B glasses | HOL-003: 46181802 (0.92) ok; HOL-004: 42142929 (0.6) MISS |
| pair-C masks | HOL-005: 42131620 (0.55) ok; HOL-006: 46182002 (0.6) ok |
| pair-D hammers | HOL-007: 27111616 (0.95) ok; HOL-008: 27111615 (0.93) ok; HOL-009: 27111617 (0.93) ok |
| pair-E tapes | HOL-010: 31201501 (0.95) ok; HOL-011: 31201502 (0.92) ok |
| pair-F ink/toner | HOL-012: 44103105 (0.93) ok; HOL-013: 44103103 (0.8) ok |
| pair-G folders | HOL-014: 44122017 (0.88) ok; HOL-015: 44122033 (0.88) ok |
| pair-H rulers | HOL-016: 44121637 (0.85) ok; HOL-017: 41111604 (0.85) ok |

Look-alike rule (same-class runner-up within 0.2): flagged 0 extra row(s) in this run.
