import { useEffect, useRef, useState } from 'react';

/**
 * The container's width in real CSS pixels.
 *
 * Charts here are drawn at their measured size rather than scaled from a fixed
 * `viewBox`. Letting the browser stretch a viewBox to fill a panel scales the
 * *text* with it — a 560-wide chart in a 1,200-wide panel renders its axis ticks
 * at more than twice their intended size, and the whole thing reads as a
 * zoomed-in screenshot. Measuring keeps the marks responsive and the type fixed.
 *
 * Falls back to the caller's default wherever `ResizeObserver` is unavailable —
 * which includes jsdom, so the charts render at a known size under test.
 */
export const useContainerWidth = (
  fallback: number,
): readonly [React.RefObject<HTMLDivElement | null>, number] => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const node = ref.current;
    if (node === null || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0;
      if (measured > 0) setWidth(Math.round(measured));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
};
