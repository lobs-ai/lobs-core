# Skills System - Implementation Summary

## Overview
Built a lightweight skills system that loads structured instructions and injects them into worker prompts when tasks match skill tags.

## What Was Built

### 1. Skills Service (`src/services/skills.ts`)
- Loads skills from two locations:
  - **Built-in:** `src/skills/` (compiled into dist/skills/)
  - **User:** `~/.lobs/skills/` (custom skills)
- Parses YAML frontmatter (description, tags)
- Matches skills to tasks based on tag matching
- Exposes `matchSkills()` and `getAll()` methods

### 2. Built-in Skills (4 total)
All located in `src/skills/*/SKILL.md`:

1. **git-workflow** - Git patterns for branching, commits, PRs
   - Tags: git, pr, pull-request, branch, commit, merge, github

2. **test-runner** - Running tests, interpreting failures
   - Tags: test, tests, testing, vitest, jest, mocha, ci, failing

3. **code-review** - Structured review checklist
   - Tags: review, code-review, pr-review, feedback, quality

4. **research** - Web research workflow
   - Tags: research, search, investigate, compare, analyze, web

### 3. Prompt Builder Integration
Modified `src/runner/prompt-builder.ts`:
- Calls `skillsService.matchSkills()` during prompt assembly
- Injects matched skills into system prompt under `## Relevant Skills` section
- Limits to max 2 skills to avoid prompt bloat

### 4. Startup Integration
Modified `src/main.ts`:
- Loads skills on startup: `skillsService.loadAll()`
- Logs skill count on boot

### 5. API Endpoint
Created `src/api/skills.ts`:
- `GET /api/skills` - Returns all loaded skills (without full instructions)
- Returns: `{ skills: [{ name, description, tags, path }] }`
- Registered in router at both `/api/skills` and `/paw/api/skills`

### 6. Build System
Modified `package.json`:
- Added `copy-skills` script: copies `src/skills/` to `dist/skills/`
- Integrated into build: `"build": "tsc && npm run copy-skills"`

## Testing Results

✅ Skills loading: 4 skills loaded successfully
✅ Tag matching: 
   - "Create PR for feature" → git-workflow
   - "Fix failing tests" → test-runner, git-workflow
   - "Review PR #42" → code-review, git-workflow
   - "Research best practices" → research, git-workflow

✅ Compiled successfully (skills service + API + prompt builder)
✅ Committed and pushed to main

## How It Works

1. **On startup:** `skillsService.loadAll()` scans `dist/skills/` and `~/.lobs/skills/`
2. **During task execution:** Prompt builder calls `matchSkills(taskTitle, taskNotes, agentType)`
3. **Matching:** Checks if any skill tags appear in the task text (case-insensitive)
4. **Injection:** Top 2 matched skills injected into system prompt before context assembly

## Skill File Format

```markdown
---
description: Short description of what this skill provides
tags: [tag1, tag2, tag3]
---

# Skill Name

## Section 1
Instructions here...

## Section 2
More guidance...
```

## Next Steps (Future)

- Add more built-in skills (debugging, deployment, api-design, etc.)
- Skill versioning and auto-updates
- Skill usage analytics (which skills match most often)
- User skill templates and examples
- Skill recommendation engine

## Commit

```
feat: skills system with built-in git, testing, review, research skills

- SkillsService loads from ~/.lobs/skills/ and built-in src/skills/
- 4 built-in skills: git-workflow, test-runner, code-review, research
- Skills matched by tags and injected into worker prompts
- GET /api/skills endpoint for Nexus UI
- Skills directory copied to dist/ during build
```

Commit: `4f9e9ab`
Pushed to: `lobs-ai/lobs-core` main branch
