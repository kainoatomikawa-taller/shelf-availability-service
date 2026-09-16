---
id: 56f75b13-1677-40f5-92b5-d5debce3f1e5-12
type: contradiction
title: `README.md`'s "## Tests" section claimed 577 tests, but running the suite on…
tags: [contradiction]
created: 2026-09-16
---
`README.md`'s "## Tests" section claimed 577 tests, but running the suite on `origin/main` (verified in a throwaway worktree) actually reports 582 passing tests — the number was already stale on main before any dashboard work. · How to apply: don't trust the README's hardcoded test count without re-running `npm test`; it was corrected to 582 during the dashboard-branch merge but could drift again as tests are added.
