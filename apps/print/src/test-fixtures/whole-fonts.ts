import { URL } from 'node:url';

// The font build's patched whole platform fonts. Those over Chrome's batch
// cache limit are served only as unicode-range chunks and kept, unserved, in
// apps/print/fonts/ as the input of their split (T07-37); the others are
// served whole from public/fonts/.
const split = new Set([
  'NotoSerifTC-Regular.otf',
  'NotoSerifTC-Bold.otf',
  'LXGWWenKaiTC-Regular.ttf',
]);

/** URL of the committed whole platform font `name`. */
export const wholeFont = (name: string) =>
  new URL(
    `../../${split.has(name) ? 'fonts' : 'public/fonts'}/${name}`,
    import.meta.url,
  );
