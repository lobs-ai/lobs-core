---
description: Git workflow patterns for branching, committing, and PR creation
tags: [git, pr, pull-request, branch, commit, merge, github]
---

# Git Workflow

## Branching
- Always create feature branches from `main`: `git checkout -b feat/description`
- Branch naming: `feat/`, `fix/`, `refactor/`, `docs/`, `test/`

## Commits
- Use conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`
- Keep commits atomic — one logical change per commit
- Write clear commit messages explaining WHY, not just what

## Pull Requests
- Always rebase on latest main before pushing: `git fetch origin main && git rebase origin/main`
- PR title should match the conventional commit format
- Include `Fixes #N` in PR body to auto-close issues
- Request review after CI passes

## Safety
- Never force-push to main
- Never commit secrets, tokens, or credentials
- Use `.gitignore` for build artifacts, node_modules, etc.
