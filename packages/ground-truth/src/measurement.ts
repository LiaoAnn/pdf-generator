// What the in-browser collector measures on a page Paged.js has finished:
// raw CSS-pixel rects in viewport coordinates, before any conversion.

/** A rect in CSS px, viewport coordinates (`getBoundingClientRect`). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where on its page an element sits: one of the page's margin boxes
 * (`.pagedjs_margin-top`, `-left`, `-right`, `-bottom` and their corners) or
 * the content area (`.pagedjs_area`). Corners count as their top or bottom row.
 */
export type Region = 'top' | 'left' | 'area' | 'right' | 'bottom';

/** One visible `data-gt` element on one page. */
export interface MeasuredElement {
  /** The `data-gt` attribute: the block type as written in the pack. */
  type: string;
  /** The `data-gt-id` attribute, or null. */
  id: string | null;
  /** Paged.js's `data-ref`: shared by an element and its split fragments. */
  ref: string | null;
  /** Paged.js's `data-split-from`: the `data-ref` of the element this fragment continues. */
  splitFrom: string | null;
  /** Index of the generated page that contains it, from 0; -1 when none does. */
  page: number;
  region: Region;
  /** Its border box. */
  rect: Rect;
  /**
   * What it is or holds that Chrome paints on whole CSS px of the printed
   * page, in document order: replaced elements (T08-2), backgrounds and
   * borders (T08-3), and T08-4's decorations: outlines and outer
   * box-shadows, and the backgrounds and borders of ::before/::after
   * pseudo-elements of it or of an element in it.
   */
  painted?: PaintedBox[];
  /** Its `innerText`. */
  text: string;
  /** True when it lies inside another `data-gt` element. */
  nested: boolean;
  /**
   * Its `data-gt-*` attributes other than `data-gt-id` (T13's markup, e.g.
   * `data-gt-checked`), by name.
   */
  attributes?: Record<string, string>;
  /** `data-gt-*` attributes on elements inside it (T13 allows none). */
  innerAttributes?: { tag: string; name: string }[];
  /** Type-specific data collected in the browser (T13: `ElementDetails`). */
  details?: unknown;
}

/**
 * Something painted on whole px inside (or being) a measured element.
 * `img`, `svg` and `box` of the element itself paint inside its border box;
 * those of an element inside it may lie outside it (T08-6: a negative
 * margin, an absolutely positioned child), as may a ::before/::after's
 * background and borders (`pseudo`), and `outline` and `shadow` paint a
 * ring or shape that may extend past it, so those only ever grow the
 * block's box, cut to the overflow clips around it and to its page.
 */
export interface PaintedBox {
  /**
   * An `<img>`, an `<svg>` not inside another `<svg>`, with computed
   * visibility `visible`, the background,
   * borders and inset box-shadows of an element (`box`), those of a
   * ::before/::after pseudo-element of it or of an element in it (`pseudo`),
   * an element's outline (`outline`), or an element's outer box-shadow
   * (`shadow`).
   */
  kind: 'img' | 'svg' | 'box' | 'pseudo' | 'outline' | 'shadow';
  /**
   * For an img or svg its border box; for a box or pseudo the area its
   * decoration covers; for an outline or shadow the decorated rect (one
   * client rect of the element, so an inline element broken over lines adds
   * one entry per line box).
   */
  rect: Rect;
  /** Outline only: the computed outline-width in CSS px. */
  width?: number;
  /** Outline only: the computed outline-offset in CSS px. */
  offset?: number;
  /** Shadow only: the shadow's x offset in CSS px. */
  offsetX?: number;
  /** Shadow only: the shadow's y offset in CSS px. */
  offsetY?: number;
  /** Shadow only: the blur radius in CSS px. */
  blur?: number;
  /** Shadow only: the spread radius in CSS px (negative shrinks the shape). */
  spread?: number;
  /**
   * Shadow only: sides this client rect lost to box-decoration-break: slice
   * (an inline element broken over lines): the shadow reaches exactly to the
   * rect's edge there and paints nothing past it.
   */
  sliced?: ('left' | 'right')[];
  /**
   * Outline, shadow and pseudo entries, and (T08-6) the img, svg and box
   * entries of an element inside the block (never the block's own): the
   * rect the entry paints inside, in viewport
   * coordinates: the intersection, over the ancestors up to its
   * `.pagedjs_page`, of each one's clip rect — its padding box on every
   * axis whose overflow is not visible, or on both axes under paint
   * containment (T08-5: the computed `contain` holds paint, strict or
   * content, or the computed `content-visibility` is auto or hidden),
   * grown by its overflow-clip-margin only when containment applies or
   * both overflows are `clip`; inline boxes, display contents/none and
   * table rows, row groups, columns and column groups clip nothing. A
   * pseudo-element's ancestors start at its host, so the host's overflow
   * clips its own pseudo-elements.
   */
  clip?: Rect;
  /**
   * Any kind: the exact (unrounded) clip-path region, in viewport
   * coordinates, that the entry paints inside: the intersection of every
   * `inset()` clip-path on the element itself and its ancestors. Present
   * only when at least one `inset()` clip-path applies (T08-5); any other
   * shape (circle(), polygon(), url(), ...) leaves the ink unconstrained.
   */
  clipPath?: Rect;
}

/** A `.pagedjs_page` border box. */
export interface MeasuredPage extends Rect {
  /**
   * The page size the document declares (`@page { size }`), in CSS px. Layout
   * snaps the box to 1/64 px (an A4 page measures 595.27 pt wide, not 595.28),
   * so when present this is the page size reported.
   */
  size?: { width: number; height: number };
}

/** Everything the collector read from one paginated document. */
export interface Measurement {
  /** Every `.pagedjs_page`, in document order. */
  pages: MeasuredPage[];
  /** Every visible `data-gt` element, in document order. */
  elements: MeasuredElement[];
}

/** What the collector reads per block type for T13's detail readers. */
export interface ElementDetails {
  /** checkbox: the `checked` property of each checkbox or radio input, the element itself first. */
  inputs?: boolean[];
  /** formula: the text of each `<annotation encoding="application/x-tex">`, untrimmed. */
  annotations?: string[];
  /**
   * formula: the rendered innerText of each KaTeX `.katex-html` part, the
   * visible rendering without the hidden MathML copy.
   */
  visibleParts?: string[];
  /** table: the rows printed on this page, when the element is a `<table>`. */
  table?: { rows: MeasuredRow[] };
}

/** A printed table row, in visual order (thead, bodies, tfoot). */
export interface MeasuredRow {
  /** Its row group (thead, a tbody, tfoot): rows with the same value share one. */
  group: number;
  cells: MeasuredCell[];
}

export interface MeasuredCell {
  /** The `rowSpan` property: 0 means to the last row of its row group. */
  rowSpan: number;
  colSpan: number;
  /** A `<th>`, or a cell in `<thead>`. */
  header: boolean;
  /** Its `innerText`. */
  text: string;
  /** Its border box relative to its `.pagedjs_page`, in CSS px. */
  rect: Rect;
  /**
   * False when it can't be in the PDF: it has more than one client rect or
   * lies outside its page, as in a row Paged.js 0.4.3 left in the content
   * area's hidden overflow (T03 §5).
   */
  printed: boolean;
  /** The checkboxes printed inside it, in document order (none: absent). */
  checkboxes?: MeasuredCheckbox[];
}

/**
 * A checkbox inside a table cell: an element with `data-gt-checked`, or a
 * checkbox or radio input outside such an element.
 */
export interface MeasuredCheckbox {
  /** Its `data-gt-checked` attribute, or null. */
  declared: string | null;
  /** The `checked` property of each checkbox or radio input, itself first. */
  inputs: boolean[];
  /**
   * The visible text after it, up to the next checkbox or the cell's end; a
   * `<br>` or a block box adds a line break.
   */
  label: string;
  /** Its border box relative to its `.pagedjs_page`, in CSS px. */
  rect: Rect;
}
