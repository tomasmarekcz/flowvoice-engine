---
name: update-docs
description: Use when code in this repo changed and docs/technical.md needs to reflect it — updates the module map incrementally based on what actually changed, or generates it from scratch on first run.
---

# Update Docs (flowvoice-engine)

Keeps `docs/technical.md` current for the voice runtime engine. Runs
either on request (`/update-docs`) or because a pre-commit hook blocked a
commit and asked for this skill to run first. Business purpose, database
schema, and cross-system architecture live in the `flowvoice` repo's
`docs/` folder (this repo is the voice runtime, not the product's source
of truth for those) — see
https://github.com/tomasmarekcz/flowvoice/blob/main/docs/architecture.md

## Step 1: Determine what changed

Read `docs/.doc-state.json` (`{ "lastDocumentedSha": "..." }`).

- **Missing:** first run — skip to "First run" below.
- **Present:** compute changed files: `git diff --name-only <lastDocumentedSha>..HEAD`
  plus `git diff --cached --name-only`, combined and de-duplicated.

If empty, still rewrite `docs/.doc-state.json` with the current HEAD sha
(Step 3) and stop.

## Step 2: Edit only the affected sections

`docs/technical.md` has one `##` section per file under `src/`
(`sms.ts`, `audio.ts`, `prompt.ts`, `logger.ts`, `session.ts`,
`call-logger.ts`, `tools.ts`, `index.ts`, `config.ts`,
`handlers/twilio.ts`, `handlers/browser.ts`), each with **Purpose**,
**Main exports**, **Depends on** / **Depended on by**. For each changed
file under `src/`, find its section and rewrite just its content using
the Edit tool — never regenerate the whole file for a small change.

## Step 3: Update the state file

Write `docs/.doc-state.json` with `{ "lastDocumentedSha": "<git rev-parse HEAD>" }`
and run `git add docs/`. Do not commit.

## First run (no docs/.doc-state.json)

Read every file under `src/` (including `src/handlers/`) and write one
`##` section per file in `docs/technical.md`: Purpose (2-4 sentences),
Main exports, Depends on / Depended on by (e.g. `tools.ts` is called by
`session.ts`, which is wired up in `handlers/twilio.ts`). Base this on the
actual current code, not on `flowvoice-engine/AGENT.md`, which may
describe deployment but not necessarily the current module boundaries.

Then write `docs/.doc-state.json` with the current HEAD sha and
`git add docs/`.
