---
id: e296a351-330a-4e25-910f-e33a1630cbb5-6
type: decision
title: computeTaskWorkRate (added to close out TaskPerformanceQueryPort) returns labourHours
tags: [decision]
created: 2026-09-15
resource: src/application/outcome-metrics.ts
---
computeTaskWorkRate (added to close out TaskPerformanceQueryPort) returns labourHours: null on breakdown slices instead of pro-rating total payroll hours across departments

## Why
splitting payroll proportionally would fabricate precision the underlying data doesn't support; cohorting matches its two sibling metrics computed by detection

## Where
src/application/outcome-metrics.ts
