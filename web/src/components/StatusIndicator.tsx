import type { StatusLevel } from '../models/status';
import { STATUS_LEVEL_GLYPHS, STATUS_LEVEL_LABELS } from '../models/status';

export interface StatusIndicatorProps {
  readonly level: StatusLevel;
  /** Overrides the level's default wording, e.g. "Below revisit threshold". */
  readonly label?: string;
  /**
   * Drops the visible label in favour of a screen-reader-only one.
   *
   * For a table cell where the column header already says what is being graded.
   * The glyph still differs per level, so the status is never carried by hue
   * alone even here — which matters on the light surface, where `warning` and
   * `serious` both sit below 3:1 against it.
   */
  readonly dotOnly?: boolean;
}

/**
 * A graded state, as a glyph plus words.
 *
 * Colour is the third channel, never the first: the glyph distinguishes the
 * levels for a colourblind reader and in forced-colors mode, and the label says
 * what the colour means so nobody has to learn the legend.
 */
export const StatusIndicator = ({ level, label, dotOnly = false }: StatusIndicatorProps) => {
  const text = label ?? STATUS_LEVEL_LABELS[level];
  return (
    <span
      className={`osa-status osa-status--${level}${dotOnly ? ' osa-status--dot-only' : ''}`}
      data-status={level}
    >
      <span className="osa-status__glyph" aria-hidden="true">
        {STATUS_LEVEL_GLYPHS[level]}
      </span>
      <span className={dotOnly ? 'osa-visually-hidden' : undefined}>{text}</span>
    </span>
  );
};
