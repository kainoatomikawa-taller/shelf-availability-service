---
id: bd3545d9-c982-4453-b7da-b4a543c2ec35-7
type: decision
title: In outcome metrics, dispatch/response lag anchors on the first task assignment while…
tags: [decision]
created: 2026-09-15
resource: src/application/outcome-metrics.ts
---
In outcome metrics, dispatch/response lag anchors on the first task assignment while resolution/verification lag anchors on the attempt that actually held (the one that got verified), with rework tracked separately via reopenCount rather than blended into either lag

## Where
src/application/outcome-metrics.ts
