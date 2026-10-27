import { afterAll, beforeAll, expect, test } from 'vitest';
import { fontFixture, geometry, probes } from './screen-media-fonts.fixture.ts';

let fixture: Awaited<ReturnType<typeof fontFixture>>;
beforeAll(async () => {
  fixture = await fontFixture(true);
});
afterAll(async () => {
  await fixture?.dispose();
});

const cases = [
  ['style', 'screen, speech'],
  ['link', 'screen, speech'],
  ['style', 'speech'],
  ['link', 'speech'],
] as const;

function sheet(kind: string, media: string) {
  return kind === 'style'
    ? `<style data-media-probe media="${media}">${fontCss}</style>`
    : `<link data-media-probe rel="stylesheet" media="${media}" href="../styles/consumed.css">`;
}

// Neither family nor Bold occurs in the base CSS. Text scanning alone cannot
// infer Bold from a normal rule: the computed print cascade must see this sheet.
const fontCss = `h1 { font-family: "Noto Serif TC"; font-weight: 700; }
  p { font-family: "LXGW WenKai TC"; }
  @media print { p { font-style: normal; } }
  @media speech { p { font-style: italic; } }`;
const base = `<style>@page { size: A4; margin: 20mm; }
  body { font-family: "Noto Sans TC"; font-size: 16px; line-height: 24px; }
  h1 { font-size: 20px; font-weight: 400; }</style>`;
const body =
  '<h1 data-gt="heading" data-font-probe>財務摘要</h1><p data-gt="paragraph" data-font-probe>公司月報</p>';

test.each(cases)(
  '%s media="%s" consumed by Paged.js embeds its otherwise unused family and real Bold',
  async (kind, media) => {
    const result = await fixture.print(
      base + sheet(kind, media),
      { 'styles/consumed.css': fontCss },
      body,
    );
    // Establish through the real Worker that Paged.js actually applies the
    // sheet in print, before asking whether the selected fonts match it.
    const printed = fixture.observations.filter(
      item => item.phase === 'printed',
    );
    expect(printed.length).toBeGreaterThan(0);
    for (const observation of printed) {
      expect(observation.styles).toEqual([
        { family: '"Noto Serif TC"', weight: '700' },
        { family: '"LXGW WenKai TC"', weight: '400' },
      ]);
    }
    expect(result.text).toContain('財務摘要公司月報');
    const faces = fixture.observations.find(
      item => item.phase === 'before',
    )?.faces;
    expect.soft(faces).toContain('LXGW WenKai TC|400');
    expect.soft(faces).toContain('Noto Serif TC|700');
    expect.soft(result.fonts).toContain('LXGWWenKaiTC-Regular');
    expect.soft(result.fonts).toContain('NotoSerifTC-Bold');
  },
);

test.each(cases)(
  '%s media="%s" restores consumed sheet attributes and CSSOM before Paged.js and ready without changing ground truth',
  async (kind, media) => {
    const css = `body div.probe { height: 350px; }
      @media print { body { margin: 0; } }
      @media speech { body div.probe { height: 100px; } }`;
    const head = `<style>${geometry}</style>`;
    const control = await fixture.print(
      `${head}<style>${css}</style>`,
      {},
      probes,
    );
    const extra =
      kind === 'style'
        ? `<style data-media-probe media="${media}">${css}</style>`
        : `<link data-media-probe rel="stylesheet" media="${media}" href="../styles/consumed.css">`;
    const result = await fixture.print(
      head + extra,
      { 'styles/consumed.css': css },
      probes,
    );
    // The 350px rule must be consumed too: ignoring the whole sheet would
    // match neither this control's block boxes nor its page count.
    expect(result.pageCount).toBe(control.pageCount);
    expect(result.gt).toEqual(control.gt);
    const ownedMedia = [
      { attribute: media, sheet: media, rules: ['print', 'speech'] },
    ];
    expect(
      fixture.observations
        .filter(item => item.phase === 'before' || item.phase === 'ready')
        .map(({ phase, ownedMedia }) => ({ phase, ownedMedia })),
    ).toEqual([
      { phase: 'before', ownedMedia },
      { phase: 'ready', ownedMedia },
    ]);
  },
);
