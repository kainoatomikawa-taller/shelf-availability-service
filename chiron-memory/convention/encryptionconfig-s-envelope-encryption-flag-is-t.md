---
id: 63094f91-5ed0-4b9a-80ca-784123f72f65-14
type: convention
title: `EncryptionConfig`'s envelope-encryption flag is typed as the literal `true` rather than…
tags: [convention]
created: 2026-09-16
resource: src/platform/encryption.ts.
---
`EncryptionConfig`'s envelope-encryption flag is typed as the literal `true` rather than `boolean`.

## Why
Makes envelope encryption non-optional and non-disableable at the type level — no code path can construct a valid config with it turned off.

## Where
src/platform/encryption.ts.
