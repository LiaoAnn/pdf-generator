import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { createPrinter, PrintFailure } from '../batch/printer.ts';

describe('failed fixture error display', () => {
  test('shows a print adapter page-count failure unchanged beside Chinese guidance about template page and body CSS', async () => {
    const printer = createPrinter(
      {
        fetch: async () =>
          Response.json(
            {
              error: {
                code: 'page_count_mismatch',
                message:
                  'The PDF has a different number of pages than Paged.js made',
              },
            },
            { status: 422 },
          ),
      },
      'local-test-token',
    );
    let failure: unknown;
    try {
      await printer.print({
        html: '<body>fixture</body>',
        page: { size: 'A4', orientation: 'portrait' },
        source: {
          templateId: 'test',
          templateVersion: 1,
          seed: 'test',
          index: 0,
        },
        pack: { template: 'template.html', files: {} },
      });
    } catch (error) {
      failure = error;
    } finally {
      await printer.close();
    }
    expect(failure).toBeInstanceOf(PrintFailure);
    if (!(failure instanceof PrintFailure))
      throw new Error('Expected a print refusal');
    const raw = failure.message;
    expect(raw).toBe(
      'print 422 page_count_mismatch: The PDF has a different number of pages than Paged.js made',
    );
    const component = await import('./fixture-error.tsx').catch(
      () => undefined,
    );
    expect(component, 'FixtureError display is not implemented').toBeDefined();
    if (!component) throw new Error('Expected FixtureError display');
    const markup = renderToStaticMarkup(<component.FixtureError error={raw} />);
    expect(markup).toContain(raw);
    expect(markup).toMatch(/[\u3400-\u9fff]/);
    expect(markup).toContain('.pagedjs');
    expect(markup).toMatch(/body/i);
    expect(markup).toMatch(/頁/);
  });

  test('keeps an unrecognized diagnostic readable and escaped without inventing a Chinese explanation', async () => {
    const raw =
      'self-check exploded: <script>alert("fixture")</script> & details';
    const component = await import('./fixture-error.tsx').catch(
      () => undefined,
    );
    expect(component, 'FixtureError display is not implemented').toBeDefined();
    if (!component) throw new Error('Expected FixtureError display');
    const markup = renderToStaticMarkup(<component.FixtureError error={raw} />);
    expect(markup).toContain(renderToStaticMarkup(raw));
    expect(markup).not.toContain('<script>');
    expect(markup).not.toMatch(/[\u3400-\u9fff]/);
  });
});
