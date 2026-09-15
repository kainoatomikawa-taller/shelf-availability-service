---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-0
type: decision
title: The domain layer was built as a strict-mode TypeScript package (Vitest for tests) rather…
tags: [decision]
created: 2026-09-15
resource: package.json, tsconfig.json at repo root
---
The domain layer was built as a strict-mode TypeScript package (Vitest for tests) rather than another stack

## Why
repo was greenfield with only a README/Chiron metadata, and Chiron's managed skills (postgres-pro, python-pro, typescript-pro) signal TypeScript/Postgres as the intended toolchain

## Where
package.json, tsconfig.json at repo root
