#!/bin/bash
# PreToolUse hook: blocks `git commit` if staged code changes aren't
# accompanied by a staged docs/.doc-state.json update (see update-docs skill).
set -euo pipefail

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

# Only act on commands that invoke `git commit`.
if ! echo "$command" | grep -qE 'git commit'; then
  exit 0
fi

staged=$(git diff --cached --name-only || true)

# Nothing staged — nothing to check (e.g. `git commit --amend` with no new stage).
if [ -z "$staged" ]; then
  exit 0
fi

non_docs=$(echo "$staged" | grep -v '^docs/' || true)

# Only docs/ files staged — a manual doc fix, don't block.
if [ -z "$non_docs" ]; then
  exit 0
fi

# Code changes are staged — docs/.doc-state.json must be staged too.
if ! echo "$staged" | grep -qx 'docs/\.doc-state\.json'; then
  echo "Staged changes touch code but docs/.doc-state.json is not staged, meaning the update-docs skill hasn't run for this change yet. Run the update-docs skill to update and stage the relevant docs files, then retry the commit." >&2
  exit 2
fi

exit 0
