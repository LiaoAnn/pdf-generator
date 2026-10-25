import { Buffer } from 'node:buffer';
import { apiErrorSchema } from '@pdf-generator/contract';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'viewport-dependent-local-test';
let worker: PrintWorker;
beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});
afterAll(async () => {
  await worker?.dispose();
});

type Fixture = {
  name: string;
  head?: string;
  body?: string;
  target?: string;
  files?: Record<string, string>;
  diagnostic: string;
};

async function post(fixture: Omit<Fixture, 'name' | 'diagnostic'>) {
  const html = `<!doctype html><html><head><style>
    @page { size: A4; margin: 20mm; }
    body { margin: 0; font: 16px/24px sans-serif; }
    .target { width: 50mm; margin: 0; }
    </style>${fixture.head ?? ''}</head><body>
    ${fixture.target ?? '<p class="target" data-gt="paragraph">VIEWPORT_GUARD_MARKER</p>'}
    ${fixture.body ?? ''}</body></html>`;
  return fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      html,
      page: { size: 'A4', orientation: 'portrait' },
      source: {
        templateId: 'viewport-guard',
        templateVersion: 1,
        seed: 'same',
        index: 0,
      },
      ...(fixture.files
        ? {
            pack: {
              template: 'index.html',
              files: Object.fromEntries(
                Object.entries(fixture.files).map(([path, contents]) => [
                  path,
                  Buffer.from(contents).toString('base64'),
                ]),
              ),
            },
          }
        : {}),
    }),
  });
}

const blackTarget =
  '<div class="target" data-gt="image" style="width:40px;height:40px;background:black"></div>';
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

// Print-only changes catch a screen-only check; short animations additionally
// catch a check that only reads animations after printing the PDF.
const animationRefusals: (Omit<Fixture, 'diagnostic'> & {
  diagnostic: RegExp;
})[] = [
  {
    name: 'short print-only animation with an escaped comma in its name',
    head: String.raw`<style data-pagedjs-ignore>
      @keyframes a\,b { from { transform:translateX(100px) } to { transform:translateX(200px) } }
      @media print { .target { animation:a\,b 1ms linear } }
      </style>`,
    target: blackTarget,
    diagnostic: /animation|a.*b/i,
  },
  {
    name: 'animation-name list with none followed by active pulse',
    head: `<style data-pagedjs-ignore>
      @keyframes pulse { from { opacity: 1; } to { opacity: .5; } }
      .target { animation-name: none, pulse; animation-duration: 999s;
        animation-iteration-count: infinite; }
      </style>`,
    diagnostic: /pulse/i,
  },
  ...[1, 2, 3].map(attempt => ({
    name: `short print-only descendant animation (attempt ${attempt})`,
    head: `<style data-pagedjs-ignore>
      .target { background: none !important; width:40px; height:40px }
      .ink { width:40px; height:40px; background:black }
      @keyframes move { from { transform:translateX(100px) } to { transform:translateX(200px) } }
      @media print { .ink { animation:move 10ms linear } }
      </style>`,
    body: '<div data-gt="image" class="target"><div class="ink"></div></div>',
    diagnostic: /move|animation/i,
  })),
  {
    name: 'transition started only when print media is emulated',
    head: `<style data-pagedjs-ignore>
      .target { transition: width 999s linear; }
      @media print { .target { width: 200px !important; } }
      </style>`,
    body: '<div data-gt="image" class="target" style="width:40px;height:40px;background:black"></div>',
    diagnostic: /width|transition/i,
  },
  {
    name: 'running keyframes on a data-gt element',
    head: `<style data-pagedjs-ignore>
      @keyframes pulse { from { opacity: 1; } to { opacity: .5; } }
      .animated { animation: pulse 999s linear infinite; }
      </style>`,
    body: '<div data-gt="image" class="animated" style="width:40px;height:40px;background:black"></div>',
    diagnostic: /pulse|opacity|animation/i,
  },
  ...['before', 'after'].map(pseudo => ({
    name: `running keyframes on ::${pseudo}`,
    head: `<style data-pagedjs-ignore>
      @keyframes pulse { from { opacity: 1; } to { opacity: .5; } }
      .animated::${pseudo} { content: ""; display: block; width: 10px; height: 10px;
        background: black; animation: pulse 999s linear infinite; }
      </style>`,
    body: '<div data-gt="image" class="animated" style="width:40px;height:40px"></div>',
    diagnostic: /pulse|opacity|animation|before|after/i,
  })),
  ...[
    [
      'animate',
      'attributeName="width" from="10" to="30" dur="999s" repeatCount="indefinite"',
    ],
    [
      'animateTransform',
      'attributeName="transform" type="translate" from="0 0" to="20 0" dur="999s" repeatCount="indefinite"',
    ],
    [
      'animateMotion',
      'path="M 0 0 L 20 0" dur="999s" repeatCount="indefinite"',
    ],
    ['set', 'attributeName="fill" to="red" begin="0s" dur="999s"'],
  ].map(([element, attributes]) => ({
    name: `printed SVG ${element} element`,
    body: `<svg data-gt="image" xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="10" height="10"><${element} ${attributes}/></rect></svg>`,
    diagnostic: new RegExp(element ?? '', 'i'),
  })),
  {
    name: 'marquee element',
    body: '<marquee data-gt="image" width="100" height="40"><div style="width:40px;height:40px;background:black"></div></marquee>',
    diagnostic: /marquee/i,
  },
];

test.each(animationRefusals)(
  'POST /print refuses $name with actionable css_animation diagnostics',
  async fixture => {
    const response = await post(fixture);
    expect(
      response.status,
      response.status === 200
        ? 'animated document printed successfully'
        : await response.clone().text(),
    ).toBe(422);
    expect(response.headers.has('x-page-count')).toBe(false);
    const { error } = apiErrorSchema.parse(await response.json());
    expect(error.code).toBe('css_animation');
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.details?.length).toBeGreaterThan(0);
    expect(
      error.details?.some(detail => fixture.diagnostic.test(detail.message)),
      JSON.stringify(error.details),
    ).toBe(true);
  },
);

// These mechanisms remain unsafe even when every measured box is stable.
const refusals: Fixture[] = [
  ...['before', 'after'].flatMap(pseudo =>
    [false, true].map(markHost => ({
      name: `fixed ::${pseudo} on display contents ${markHost ? 'data-gt host' : 'unmarked descendant'}`,
      head: `<style data-pagedjs-ignore>
        .image { width:40px; height:40px; }
        .host { display:contents; }
        .host::${pseudo} { content:""; position:fixed; left:100px; top:50px;
          width:40px; height:40px; background:black; }
        </style>`,
      target: markHost
        ? '<div class="image"><div data-gt="image" class="host"></div></div>'
        : '<div data-gt="image" class="image"><div class="host"></div></div>',
      diagnostic: 'fixed',
    })),
  ),
  {
    name: 'generated fixed before pseudo-element',
    head: `<style data-pagedjs-ignore>
      .target::before { content: ""; position: fixed; width: 10px; height: 10px; background: black; }
      </style>`,
    target: blackTarget,
    diagnostic: 'fixed',
  },
  // Chrome repeats fixed ink on every printed page, but the DOM has only
  // one element for ground truth. Stable before/after boxes cannot catch it.
  ...[
    [
      'plain stylesheet',
      '<style>.target { position:fixed; left:100px; top:100px; }</style>',
    ],
    [
      'print-only ignored stylesheet',
      '<style data-pagedjs-ignore>@media print { .target { position:fixed; left:100px; top:100px; } }</style>',
    ],
    [
      'unmarked descendant in print media',
      '<style data-pagedjs-ignore>@media print { .ink { position:fixed; left:100px; top:100px; } }</style>',
    ],
  ].map(([name, head]) => ({
    name: `computed position fixed from ${name}`,
    head,
    body: `<div data-gt="image" style="width:40px;height:40px"><div class="ink" style="width:10px;height:10px;background:black"></div></div>
      <p data-gt="paragraph" style="break-before:page">SECOND_PAGE_MARKER</p>`,
    diagnostic: 'fixed',
  })),
  {
    name: 'picture source media attribute size query',
    body: '<picture><source media="(min-width: 793.5px)" srcset="wide.svg"><img data-gt="image" src="narrow.svg"></picture>',
    files: {
      'narrow.svg': svg.replace('width="10"', 'width="40"'),
      'wide.svg': svg.replace('width="10"', 'width="200"'),
    },
    diagnostic: 'min-width',
  },
  ...['print', 'screen'].map(media => ({
    name: `picture source with plain ${media} media`,
    body: `<picture><source media="${media}" srcset="pixel.svg"><img data-gt="image" src="pixel.svg"></picture>`,
    files: { 'pixel.svg': svg },
    diagnostic: media,
  })),
];

test.each(refusals)(
  'POST /print refuses $name with actionable viewport_dependent diagnostics',
  async fixture => {
    const response = await post(fixture);
    expect(
      response.status,
      response.status === 200
        ? 'unsafe document printed successfully'
        : await response.clone().text(),
    ).toBe(422);
    expect(response.headers.has('x-page-count')).toBe(false);
    const { error } = apiErrorSchema.parse(await response.json());
    expect(error.code).toBe('viewport_dependent');
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.details?.length).toBeGreaterThan(0);
    expect(
      error.details?.some(detail =>
        detail.message.toLowerCase().includes(fixture.diagnostic.toLowerCase()),
      ),
      JSON.stringify(error.details),
    ).toBe(true);
  },
);

// Regression: scanning raw HTML/CSS tokens instead of values refuses innocent
// strings, asset names, content attr(), and fixed or font-relative dimensions.
const controls: Omit<Fixture, 'diagnostic'>[] = [
  ...['before', 'after'].flatMap(pseudo =>
    ['host', 'ancestor'].map(hidden => ({
      name: `fixed ::${pseudo} on display contents host with display none ${hidden}`,
      head: `<style data-pagedjs-ignore>
        .image { width:40px; height:40px; }
        .host { display:contents; }
        .${hidden} { display:none; }
        .host::${pseudo} { content:""; position:fixed; left:100px; top:50px;
          width:40px; height:40px; background:black; }
        </style>`,
      body: '<div data-gt="image" class="image"><div class="ancestor"><div class="host"></div></div></div>',
    })),
  ),
  {
    name: 'size container inside page content',
    head: `<style data-pagedjs-ignore>
      .box { container-type: inline-size; width: 50mm; }
      @container (min-width: 10mm) { .target { position: relative; left: 10px; } }
      </style>`,
    target: `<div class="box">${blackTarget}</div>`,
  },
  {
    name: 'display none element with computed position fixed',
    head: '<style data-pagedjs-ignore>.hidden { display: none; position: fixed; }</style>',
    body: '<div class="hidden">HIDDEN_FIXED_MARKER</div>',
  },
  {
    name: 'fixed before pseudo-element without content',
    head: '<style data-pagedjs-ignore>.target::before { position: fixed; }</style>',
    target: blackTarget,
  },
  ...[
    [
      'aria-label on SVG',
      '<svg width="10" height="10" aria-label="100vw"><rect width="10" height="10"/></svg>',
    ],
    [
      'data-note on SVG rect',
      '<svg width="10" height="10"><rect width="10" height="10" data-note="50vw"/></svg>',
    ],
  ].map(([name, body]) => ({
    name: `non-rendering ${name} containing a viewport-looking token`,
    body,
  })),
  {
    name: 'animation-name referencing missing keyframes',
    head: '<style data-pagedjs-ignore>.target { animation-name: missing; animation-duration: 1s; }</style>',
  },
  {
    name: 'animation-name list containing only none',
    head: `<style data-pagedjs-ignore>
      @keyframes pulse { from { opacity: 1; } to { opacity: .5; } }
      .target { animation-name: none, none; animation-duration: 999s;
        animation-iteration-count: infinite; }
      </style>`,
  },
  ...['absolute', 'relative', 'sticky'].map(position => ({
    name: `computed position ${position}`,
    head: `<style data-pagedjs-ignore>.target { position:${position}; left:10px; top:10px; }</style>`,
  })),
  {
    name: 'fixed declaration overridden to computed relative on screen and print',
    head: `<style data-pagedjs-ignore>
      .target { position:fixed; left:10px; top:10px; }
      .target { position:relative; }
      </style>`,
  },
  {
    name: 'transition declared without any screen-to-print style change',
    head: '<style data-pagedjs-ignore>.target { transition: width 999s linear; }</style>',
    body: '<div data-gt="image" class="target" style="width:40px;height:40px;background:black"></div>',
  },
  {
    name: 'unused keyframes declaration',
    head: '<style data-pagedjs-ignore>@keyframes unused { from { opacity: 1; } to { opacity: .5; } }</style>',
  },
  {
    name: 'animation explicitly disabled with animation none',
    head: `<style data-pagedjs-ignore>
      @keyframes pulse { from { opacity: 1; } to { opacity: .5; } }
      .target { animation: pulse 999s linear infinite; }
      .target { animation: none; }
      </style>`,
  },
  ...['img', 'source'].map(tag => ({
    name: `${tag} density-descriptor srcset without sizes`,
    body:
      tag === 'img'
        ? '<img data-gt="image" src="a.svg" srcset="a.svg 1x, b.svg 2x">'
        : '<picture><source srcset="a.svg 1x, b.svg 2x"><img data-gt="image" src="a.svg"></picture>',
    files: { 'a.svg': svg, 'b.svg': svg },
  })),
  ...['img', 'source'].flatMap(tag =>
    ['invalid', '10px', '50vw', '(max-width: 800px) 10px, 20px'].map(sizes => ({
      name: `${tag} sizes="${sizes}" without srcset`,
      body:
        tag === 'img'
          ? `<img data-gt="image" src="pixel.svg" sizes="${sizes}">`
          : `<picture><source sizes="${sizes}"><img data-gt="image" src="pixel.svg"></picture>`,
      files: { 'pixel.svg': svg },
    })),
  ),
  {
    name: 'picture source without media or descriptors',
    body: '<picture><source srcset="pixel.svg"><img data-gt="image" src="pixel.svg"></picture>',
    files: { 'pixel.svg': svg },
  },
  ...['video', 'audio'].map(tag => ({
    name: `${tag} source media does not select a picture image`,
    body: `<${tag}><source media="(min-width: 793.5px)"></${tag}>`,
  })),
  {
    name: 'image with only a plain src and intrinsic dimensions',
    body: '<img data-gt="image" src="pixel.svg">',
    files: { 'pixel.svg': svg },
  },
  {
    name: 'CSS strings and comments containing forbidden-looking tokens',
    head: `<style>/* 50vw; @media (min-width: 1px); attr(data-w) */
      .target::after { content: "50vw 1dvh 1cqw attr(data-w) (min-width: 1px)"; }
      .target { --label: "50vw"; }</style>`,
  },
  {
    name: 'url filenames containing viewport units and attr tokens',
    head: '<style>.target { background-image: url("50vw-attr(fake).svg"), url(50vw.svg); }</style>',
    files: { '50vw-attr(fake).svg': svg, '50vw.svg': svg },
  },
  {
    name: 'attr in content and ordinary HTML attributes',
    head: '<style>.target::after { content: attr(data-label); }</style>',
    body: '<div data-width="50vw" title="50vw attr(data-w)"></div>',
  },
  {
    name: 'px mm percent em rem and ch lengths',
    head: '<style>.target { width: 50mm; max-width: 100%; padding: 1px; margin-left: 1em; font-size: 1rem; text-indent: 1ch; }</style>',
  },
  {
    name: 'plain print and screen media rules and attributes',
    head: `<style media="screen">.target { color: black; }</style>
      <style data-pagedjs-ignore>@media print { .target { color: black; } } @media screen { .target { color: black; } }</style>
      <link rel="stylesheet" media="print" href="safe.css">`,
    files: { 'safe.css': '@media print { .target { color: black; } }' },
  },
  {
    name: 'import with a plain print media list',
    head: '<style>@import "safe.css" print;</style>',
    files: { 'safe.css': '.target { color: black; }' },
  },
  {
    name: 'fixed SVG dimensions and fixed image sizes',
    body: '<svg width="10" height="10"><rect width="10" height="10"/></svg><img src="pixel.svg" sizes="10px" width="10" height="10">',
    files: { 'pixel.svg': svg },
  },
];

test.each(controls)(
  'POST /print accepts viewport-independent control: $name',
  async fixture => {
    const response = await post(fixture);
    expect(
      response.status,
      response.status === 200 ? '' : await response.text(),
    ).toBe(200);
    const body = (await response.json()) as {
      pdf: string;
      gt: { blocks: unknown[] };
    };
    expect(Buffer.from(body.pdf, 'base64').subarray(0, 5).toString()).toBe(
      '%PDF-',
    );
    expect(body.gt.blocks.length).toBeGreaterThan(0);
  },
);
