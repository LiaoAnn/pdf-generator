import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  cascade,
  fontFixture,
  geometry,
  probes,
} from './screen-media-fonts.fixture.ts';

let fixture: Awaited<ReturnType<typeof fontFixture>>;
beforeAll(async () => {
  fixture = await fontFixture();
});
afterAll(async () => {
  await fixture?.dispose();
});

test.each(['screen', 'only screen and (min-width: 1px)', 'speech'])(
  '%s rules cannot hide the inherited print family’s real Bold face',
  async media => {
    const result = await fixture.print(
      `<style>${cascade} @media ${media} { h1 { font-weight: normal; } p { font-family: "LXGW WenKai TC"; } }</style>`,
    );
    expect(result.fonts).toContain('NotoSerifTC-Bold');
    expect(result.text).toContain('財務摘要');
    expect(
      fixture.observations.find(item => item.phase === 'before')?.faces,
    ).toContain('Noto Serif TC|700');
    expect(
      fixture.observations.find(item => item.phase === 'before')?.faces,
    ).not.toContain('LXGW WenKai TC|400');
  },
);

test('screen media is restored before pagination and ready without changing ground-truth boxes', async () => {
  const head = `<style>${geometry}</style>`;
  const printRule =
    '@media print { html { font-family: "Noto Serif TC"; } body div.probe { height: 100px; } }';
  const control = await fixture.print(
    `${head}<style data-pagedjs-ignore>${printRule}</style>`,
    {},
    probes,
  );
  const result = await fixture.print(
    `${head}<style data-pagedjs-ignore data-media-probe>
    @media screen { body div.probe { height: 400px; } }
    ${printRule}
    @media speech { body div.probe { height: 50px; } }
    </style>`,
    {},
    probes,
  );
  expect(result.pageCount).toBe(2);
  expect(control.pageCount).toBe(2);
  expect(result.gt).toEqual(control.gt);
  // The higher-specificity ignored print rule must actually shrink the boxes.
  expect(result.gt.blocks.map(block => block.bbox[3] - block.bbox[1])).toEqual([
    75, 75, 75, 75,
  ]);
  expect(
    fixture.observations.map(({ phase, media }) => ({ phase, media })),
  ).toEqual([
    {
      phase: 'before',
      media: [{ sheet: '', rules: ['screen', 'print', 'speech'] }],
    },
    {
      phase: 'ready',
      media: [{ sheet: '', rules: ['screen', 'print', 'speech'] }],
    },
  ]);
});
