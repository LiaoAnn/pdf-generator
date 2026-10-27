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

test.each(['import screen', 'import speech', 'style screen', 'link screen'])(
  '%s sheet neither hides an inherited print Bold face nor declares its screen-only face',
  async kind => {
    const css =
      'h1 { font-weight: normal !important; } p { font-family: "LXGW WenKai TC"; }';
    const head = kind.startsWith('import')
      ? '<link rel="stylesheet" href="../styles/report.css">'
      : `<style>${cascade}</style>${kind === 'style screen' ? `<style media="screen">${css}</style>` : '<link rel="stylesheet" media="screen" href="../styles/nonprint.css">'}`;
    const result = await fixture.print(head, {
      'styles/nonprint.css': css,
      'styles/report.css': `@import "../styles/nonprint.css" ${kind.split(' ')[1]}; ${cascade}`,
    });
    expect(result.fonts).toContain('NotoSerifTC-Bold');
    expect(result.text).toContain('財務摘要');
    const faces = fixture.observations.find(
      item => item.phase === 'before',
    )?.faces;
    expect(faces).toContain('Noto Serif TC|700');
    expect(faces).not.toContain('LXGW WenKai TC|400');
  },
);

test.each([
  'import screen',
  'import speech',
  'style screen',
  'style speech',
  'link screen',
  'link speech',
])(
  '%s sheet media is restored before pagination and ready and preserves control ground truth',
  async entry => {
    const [kind, medium] = entry.split(' ');
    const css = `body div.probe { height: ${medium === 'screen' ? 400 : 100}px; }`;
    const head = `<style>${geometry}</style>`;
    const control = await fixture.print(head, {}, probes);
    const extra =
      kind === 'import'
        ? `<style data-pagedjs-ignore data-media-probe>@import "../styles/nonprint.css" ${medium};</style>`
        : kind === 'style'
          ? `<style data-pagedjs-ignore data-media-probe media="${medium}">${css}</style>`
          : `<link data-pagedjs-ignore data-media-probe rel="stylesheet" media="${medium}" href="../styles/nonprint.css">`;
    const result = await fixture.print(
      `${head}${extra}<style>@media print { html { font-family: "Noto Serif TC"; } }</style>`,
      { 'styles/nonprint.css': css },
      probes,
    );
    expect(result.pageCount).toBe(2);
    expect(result.gt).toEqual(control.gt);
    const media = [
      {
        sheet: kind === 'import' ? '' : medium,
        rules: kind === 'import' ? [medium] : [],
      },
    ];
    expect(
      fixture.observations.map(({ phase, media }) => ({ phase, media })),
    ).toEqual([
      { phase: 'before', media },
      { phase: 'ready', media },
    ]);
  },
);
