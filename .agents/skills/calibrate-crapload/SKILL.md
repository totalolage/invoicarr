---
name: calibrate-crapload
description: Calibrate Crapload against a developer's blind TypeScript complexity ratings. Use for tuning config or presets, testing scoring-rule changes, or validating the metric on a new codebase.
---

# Calibrate Crapload

From the repo root, run `bun install --frozen-lockfile`. The pinned Git dependency provides `node_modules/crapload/src/cli.ts`. Check it with `bun node_modules/crapload/src/cli.ts --version`.

1. **Capture the baseline.** Run `bun node_modules/crapload/src/cli.ts --no-coverage --format json > baseline.json`. A threshold failure still writes the report. Record the source revision, Crapload version, and config. Run `bun node_modules/crapload/src/cli.ts calibrate sample --out-dir round-1` to save `sample.json` and `blind-ranking.html`. Keep the source revision fixed across formula comparisons so ranks reflect scoring changes.
2. **Keep the quiz blind.** Give the developer only the path to `blind-ranking.html`. Ask them to rate each snippet from 1 for easy to understand through 5 for hard, then export the ratings JSON. Keep the answer key, sampled names, buckets, and scores private until the ratings are in.
3. **Diagnose rank gaps.** Save the exported JSON without editing it and run `bun node_modules/crapload/src/cli.ts calibrate analyze --sample round-1/sample.json --ratings round-1/ratings.json`. Read the source and per-statement costs for the largest gaps in both directions. Check the score against line count and cyclomatic complexity. Repeat `--ratings` after the same `--sample` to measure agreement between raters. For a combined analysis, list each `--sample` followed by its ratings files.
4. **Classify every gap before editing.** Assign each to one of these tiers and record the source and scoring evidence.

   - **Config or preset.** Start here when a framework pattern inflates scores. Test adjustments to `weights`, `transparentWrappers`, `flatChainMethods`, or `ignoredDeclarations` against examples of that pattern.
   - **Engine rule.** Change AST scoring when multiple real functions expose the same structural flaw. Write a regression test for the rule and run the full-repo mover check below.
   - **Limit of static analysis.** Record embedded DSL logic, such as raw SQL, and cross-file domain or concurrency semantics. Leave the syntax formula alone for these cases.

5. **Check movers across the repo.** Capture the candidate report with the baseline's paths and scoring mode. Join it to the baseline by unit ID. Inspect the largest score drops, largest rises, and the candidate's top 15. Resolve unexpected moves before presenting the candidate.
6. **Adjudicate on fresh code.** Run `bun node_modules/crapload/src/cli.ts calibrate sample --compare baseline.json --exclude-sample round-1/sample.json --out-dir round-2` with the candidate. Repeat `--exclude-sample` for every earlier round. To test a specific weakness, add `--bucket high-state`, `--bucket declarative`, or `--bucket upper-tail`. Check that the new answer key shares no unit IDs with earlier rounds. Repeat the blind handoff and analyze the new ratings with `--compare baseline.json`.
7. **Stop and freeze.** Freeze the formula once held-out Spearman correlation beats the baselines and inspection confirms that the top scores still flag hard code. If the reference corpus changed, re-pin `calibrationFactor` on that corpus and recheck the final candidate. Get a code review for engine rule edits. Save the final config, reports, and round results so the next calibration can start from the same evidence.
