// T06-13: the SVG check (svg.ts) reports the same problems in .svg files as
// the asset check (assets.ts) reports in the template and stylesheets, so
// these message texts live here once instead of twice.

/** Why a repeating-linear/radial-gradient() is refused, and what to draw. */
export const repeatingGradientMessage =
  'repeating-linear-gradient() and repeating-radial-gradient() print as a shading the self-check misreads (stripes read solid black or blank, rings as a scrambled pattern): draw them as SVG <rect> or <circle> elements, or repeat a fixed-size linear-gradient sized in pt, e.g. background: linear-gradient(90deg, #000 50%, transparent 50%) 0 0 / 4pt 100%';
/** Why spreadMethod="repeat"/"reflect" is refused, and what to draw. */
export const spreadMethodMessage =
  'spreadMethod="repeat" and "reflect" print as a shading the self-check reads once per stripe (solid black or blank): draw the stripes as SVG <rect> elements, or repeat a fixed-size linear-gradient sized in pt, e.g. background: linear-gradient(90deg, #000 50%, transparent 50%) 0 0 / 4pt 100%';
/** Why a backslash escape in CSS is refused. */
export const cssEscapeMessage =
  'a backslash escape in CSS: write the character itself (packs are UTF-8)';
/** Why a non-data:, non-#id reference inside an SVG image is refused. */
export const svgNestedRefMessage = (url: string) =>
  `an SVG image loads no other file or URL, so "${url}" prints nothing: draw it in this SVG, or use a data: URL (a #id in the same SVG is fine)`;
/** Why a function inside image-set() is refused. */
export const dynamicAssetMessage =
  'image-set() takes only url(), strings, type() and gradients: another function here (var(), if(), a custom function …) can supply a URL this check cannot see';
