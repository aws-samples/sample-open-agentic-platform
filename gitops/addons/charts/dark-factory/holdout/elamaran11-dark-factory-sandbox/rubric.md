# Holdout rubric — elamaran11/dark-factory-sandbox

The judge scores each scenario **PASS/FAIL** against the built code on the coder's `df/issue-N`
branch. This rubric is for the LLM judge only; the coder never sees it.

A scenario is satisfied only when BOTH hold:

1. **Executable test is green** — the hidden test for that scenario, run against the built code,
   exits 0. This is the hard signal (a `return true` stub cannot pass a real test).
2. **The plain-English behaviour is met** — the judge, reading the scenario and the actual code diff,
   confirms the described behaviour is genuinely implemented (not faked, not hard-coded to the
   examples, no obvious way to game the test).

Score PASS only if you are confident on both. When uncertain, score FAIL — a false PASS is worse than
a false FAIL here. Ignore code style, comments, and formatting; judge behaviour only.
