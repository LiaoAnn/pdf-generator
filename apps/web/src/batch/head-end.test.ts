import { describe, expect, it } from 'vitest';
import { fixtureReport } from '../templates/fixture-pack.ts';
import { render } from './fixture.ts';

describe('render links styles at the HTML head boundary', () => {
  it.each(['</head >', '</HEAD>', '</head\n>'])(
    'places links before the real %s instead of a comment or title decoy',
    end => {
      const prefix =
        '<html><head><!-- </head> --><title>literal </head> text</title>';
      const suffix = '<body>Report</body></html>';
      const pack = {
        ...fixtureReport,
        template: `${prefix}${end}${suffix}`,
        manifest: {
          ...fixtureReport.manifest,
          files: {
            ...fixtureReport.manifest.files,
            styles: ['first.css', 'last.css'],
          },
        },
      };
      expect(render(pack, {})).toBe(
        `${prefix}<link rel="stylesheet" href="first.css">\n<link rel="stylesheet" href="last.css">\n${end}${suffix}`,
      );
    },
  );

  it.each([
    '<html><head><title>Report</title><body>Report</body></html>',
    '<html><head><!-- </head> --><title>literal </head> text</title><body>Report</body></html>',
  ])('throws when the head has no explicit end tag: %s', template => {
    expect(() => render({ ...fixtureReport, template }, {})).toThrow(/head/i);
  });
});
