---
description: Running tests, interpreting failures, and fixing test issues
tags: [test, tests, testing, vitest, jest, mocha, ci, failing]
---

# Test Runner

## Running Tests
- Check package.json for test script: `npm test` or `npx vitest`
- Run specific test file: `npx vitest run path/to/test.ts`
- Run with verbose output: `npx vitest run --reporter=verbose`

## Interpreting Failures
- Read the FULL error message and stack trace
- Identify: is it a test bug or a code bug?
- Check if the test expectations match the actual behavior
- Look for common issues: async timing, mock setup, import errors

## Fixing
- Fix the code to match the spec, NOT the test to match broken code
- If the spec changed, update both code and tests
- Always re-run after fixing to confirm the fix works
- Run the full suite, not just the fixed test
