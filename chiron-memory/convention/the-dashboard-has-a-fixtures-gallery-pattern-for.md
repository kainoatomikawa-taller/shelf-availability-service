---
id: 56f75b13-1677-40f5-92b5-d5debce3f1e5-10
type: convention
title: The dashboard has a fixtures + gallery pattern for isolated component rendering
tags: [convention]
created: 2026-09-16
resource: web/src/fixtures/, web/src/gallery/Gallery.tsx.
---
The dashboard has a fixtures + gallery pattern for isolated component rendering: `web/src/fixtures/sample-data.ts` produces deterministic sample reports/records, and `web/src/gallery/Gallery.tsx` renders every shared component against them, viewable via `npm run dev:web`.

## Where
web/src/fixtures/, web/src/gallery/Gallery.tsx.
