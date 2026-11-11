# Frozen classifier for the holdout run

Frozen at commit **acf8af7** (`fix: remove UNSPSC list from repo, degrade cleanly without it, add MIT licence`).
No change to the prompts, shortlist, normalisation, model or temperature after this point. If `git log acf8af7..HEAD -- src/classify.js` is not empty, the freeze is broken: say so in the report.

| What | Value |
|---|---|
| `src/classify.js` git blob | `5ae41f7bb202228499d601646dec904a6df05402` |
| `CLASSIFIER_VERSION` | 2 |
| Model | `anthropic/claude-haiku-5.5` (`LLM_MODEL`; `LLM_MODEL_NORMALIZE` unset, so the same model) |
| Temperature / seed | 0 / 42 (seed is best effort) |
| Shortlist size / flag threshold / look-alike gap | 40 / 0.6 / 0.2 |
| Local code list | `data/unspsc-subset.csv`, sha256 `fb97b9317f439cea53a7c4075c04aa81a54afe4442e6ac253b474ca1444f5b8d` (the list itself is UNDP-copyrighted and not in the repo) |

Changes to `src/classify.js` since the tuned 60-row set: only plumbing (code-list path env override, "no list" error, `#` comment lines skipped, LLM timeout/attempt env knobs for the server). No prompt, shortlist or scoring change.

Run once, then report in `eval/holdout-report.md`. Labels (`labels-proposed.csv`) must be human-verified before the run; any label change after the run must be disclosed.
