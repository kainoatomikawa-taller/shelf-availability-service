---
id: 56f75b13-1677-40f5-92b5-d5debce3f1e5-7
type: gotcha
title: SVG charts (`LineChart`/`BarChart`) that scale purely via `viewBox` stretch text and…
tags: [gotcha]
created: 2026-09-16
resource: web/src/components/charts/ (useContainerWidth.ts, LineChart.tsx, BarChart.tsx).
---
SVG charts (`LineChart`/`BarChart`) that scale purely via `viewBox` stretch text and strokes ~2x when the rendered container is wider than the chart's native aspect ratio.

## Why
viewBox-only scaling assumes uniform container sizing, which doesn't hold once charts sit in responsive dashboard panels. · How to apply: measure the actual container width (e.g. a `useContainerWidth` hook with ResizeObserver) and lay out the chart to that width instead of relying on viewBox scaling.

## Learned
only surfaced via a real-browser screenshot check, not by component unit tests.

## Where
web/src/components/charts/ (useContainerWidth.ts, LineChart.tsx, BarChart.tsx).
