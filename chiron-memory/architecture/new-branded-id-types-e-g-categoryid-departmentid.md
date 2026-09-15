---
id: ebdcf5b4-01ca-4940-9da8-272aa1a78dd3-14
type: architecture
title: New branded ID types (e.g
tags: [architecture]
created: 2026-09-15
resource: src/domain/common/ids.ts
---
New branded ID types (e.g. CategoryId, DepartmentId) were added to src/domain/common/ids.ts to support merchandising classification, following the existing Brand<string, 'Foo'> pattern used for all other domain ids

## Where
src/domain/common/ids.ts
