---
id: bd3545d9-c982-4453-b7da-b4a543c2ec35-1
type: architecture
title: Task dispatch batches ESL commands per store up to the gateway's declared batch limit,…
tags: [architecture]
created: 2026-09-15
resource: src/application/create-tasks.use-case.ts
---
Task dispatch batches ESL commands per store up to the gateway's declared batch limit, and any task the fleet can't carry (ladder bottoms out at 'none') is returned in routedElsewhere instead of being sent

## Where
src/application/create-tasks.use-case.ts
