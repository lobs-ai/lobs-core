---
description: Structured code review checklist and patterns
tags: [review, code-review, pr-review, feedback, quality]
---

# Code Review

## Checklist
1. **Correctness:** Does the code do what it claims?
2. **Edge cases:** What happens with empty input, null, large data?
3. **Error handling:** Are errors caught and handled gracefully?
4. **Security:** Any SQL injection, XSS, auth bypass risks?
5. **Performance:** Any N+1 queries, unnecessary loops, missing indexes?
6. **Readability:** Can another developer understand this in 30 seconds?
7. **Tests:** Are there tests? Do they cover the happy path AND edge cases?
8. **Breaking changes:** Does this break existing functionality or APIs?

## Feedback Style
- Be specific: "Line 42: this could NPE if user is null" not "handle nulls"
- Suggest fixes, don't just point out problems
- Distinguish: blocking issues vs. nits vs. suggestions
- Acknowledge good patterns when you see them
