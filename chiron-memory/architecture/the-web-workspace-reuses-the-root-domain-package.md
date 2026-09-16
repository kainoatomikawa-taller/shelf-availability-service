---
id: 56f75b13-1677-40f5-92b5-d5debce3f1e5-13
type: architecture
title: The `web/` workspace reuses the root domain package's strict TypeScript settings…
tags: [architecture]
created: 2026-09-16
resource: web/tsconfig.json.
---
The `web/` workspace reuses the root domain package's strict TypeScript settings (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) and the domain's extensionless-import style rather than relaxing them for the frontend.

## Where
web/tsconfig.json.
