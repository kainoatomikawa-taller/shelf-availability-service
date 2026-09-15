---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-12
type: convention
title: Every domain entity carries a first-class retailer partition key, enforced via a shared…
tags: [convention]
created: 2026-09-15
resource: src/domain/common/errors.ts and used throughout src/domain/*
---
Every domain entity carries a first-class retailer partition key, enforced via a shared RetailerPartitioned contract with assertSameRetailer/assertSinglePartition helpers that throw CrossRetailerAccessError

## Why
acceptance criteria required strictly no cross-retailer pooling at the model level

## Where
src/domain/common/errors.ts and used throughout src/domain/*
