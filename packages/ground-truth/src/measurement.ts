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
  /** Index of its `.pagedjs_page` in document order, from 0. */
  page: number;
  region: Region;
  /** Its border box. */
  rect: Rect;
  /** Its `innerText`. */
  text: string;
  /** True when it lies inside another `data-gt` element. */
  nested: boolean;
  /**
   * Its `data-gt-*` attributes other than `data-gt-id` (T13's markup, e.g.
   * `data-gt-checked`), by name.
   */
  attributes?: Record<string, string>;
  /** Type-specific data collected in the browser (T13: `ElementDetails`). */
  details?: unknown;
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
}
