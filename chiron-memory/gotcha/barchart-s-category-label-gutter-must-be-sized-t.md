---
id: 56f75b13-1677-40f5-92b5-d5debce3f1e5-8
type: gotcha
title: `BarChart`'s category-label gutter must be sized to fit the longest label string,…
tags: [gotcha]
created: 2026-09-16
resource: web/src/components/charts/BarChart.tsx.
---
`BarChart`'s category-label gutter must be sized to fit the longest label string, otherwise long category labels overflow the panel edge.

## Learned
also only visible via an actual rendered screenshot, not the render-only unit tests.

## Where
web/src/components/charts/BarChart.tsx.
