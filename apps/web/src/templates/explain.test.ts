import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type ApiError, apiErrorSchema } from '@pdf-generator/contract';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { zipSync } from 'fflate';
import { beforeEach, describe, expect, test } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { createLocalAccess, localServiceToken } from '../access/local.ts';
import { createFetchHandler } from '../worker.ts';

type ErrorBody = ApiError['error'];
type Detail = NonNullable<ErrorBody['details']>[number];
type Explanation = {
  title: string;
  issues: {
    code: string | undefined;
    explanation: string;
    location: string | undefined;
    raw: string;
  }[];
};
// Keep diagnostics focused on the missing module while the implementation is RED.
let explain: (error: ErrorBody) => Explanation;
beforeEach(async () => {
  explain = (await import('./explain.ts')).explainError;
});
const cjk = /[\u3400-\u9fff]/;

function invalid(details: Detail[]): Explanation {
  return explain({
    code: 'invalid_template_pack',
    message: 'Template pack validation failed',
    details,
  });
}

function fallback(): string | undefined {
  return invalid([{ code: 'future-code', message: 'Unknown problem' }])
    .issues[0]?.explanation;
}

async function readPack(root: URL): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const children = await readPack(new URL(`${entry.name}/`, root));
      for (const [path, bytes] of Object.entries(children)) {
        files[`${entry.name}/${path}`] = bytes;
      }
    } else {
      files[entry.name] = new Uint8Array(
        await readFile(new URL(entry.name, root)),
      );
    }
  }
  return files;
}

describe('template author error explanations', () => {
  test('broken-pack HTTP refusals retain every diagnostic and explain its real source location in Chinese', async () => {
    const platform = await getPlatformProxy<Env>({
      configPath: fileURLToPath(
        new URL('../../wrangler.jsonc', import.meta.url),
      ),
      persist: false,
    });
    try {
      await migrate(drizzle(platform.env.DB), {
        migrationsFolder: fileURLToPath(
          new URL('../../drizzle', import.meta.url),
        ),
      });
      const local = createLocalAccess();
      const handle = createFetchHandler({
        pages: async () =>
          new Response('Unexpected page handler', { status: 599 }),
        access: () => local.config,
        edge: local.edge,
      });
      const fixtures = new URL(
        '../../../../packages/template-tools/fixtures/broken/',
        import.meta.url,
      );
      const names = (await readdir(fixtures)).sort();
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        const bytes = zipSync(
          await readPack(new URL(`${name}/pack/`, fixtures)),
        );
        const response = await handle(
          new Request('https://web.example.test/api/templates', {
            method: 'POST',
            headers: {
              'content-type': 'application/zip',
              'CF-Access-Client-Id': localServiceToken.clientId,
              'CF-Access-Client-Secret': localServiceToken.clientSecret,
            },
            body: new Uint8Array(bytes),
          }),
          platform.env,
        );
        expect(response.status, name).toBe(400);
        const { error } = apiErrorSchema.parse(await response.json());
        expect(error.code, name).toBe('invalid_template_pack');
        const details = error.details ?? [];
        expect(details.length, name).toBeGreaterThan(0);
        const result = explain(error);
        expect(result.title, name).toMatch(cjk);
        expect(result.title, name).toContain(String(details.length));
        expect(
          result.issues.map(issue => issue.raw),
          name,
        ).toEqual(details.map(detail => detail.message));
        for (const [index, detail] of details.entries()) {
          const issue = result.issues[index];
          expect(detail.code, name).toEqual(expect.any(String));
          expect(detail.message, name).not.toMatch(/^[a-z][a-z0-9_-]*: /);
          expect(issue?.code, name).toBe(detail.code);
          expect(issue?.explanation, name).toMatch(cjk);
          expect(issue?.explanation, name).not.toBe(fallback());
          if (detail.file) expect(issue?.location, name).toContain(detail.file);
          if (detail.line) {
            expect(issue?.location, name).toContain(`第 ${detail.line} 行`);
          }
        }
      }
    } finally {
      await platform.dispose();
    }
  }, 60_000);

  const uploadCodes = [
    'zip-invalid',
    'path-invalid',
    'pack-too-large',
    'pack-too-complex',
    'pack-too-many-files',
    'file-too-large',
    'pack-text-too-large',
    'pack-check-failed',
    'manifest-missing',
    'manifest-invalid',
    'file-missing',
    'file-unlisted',
    'text-encoding',
    'json-syntax',
    'rules-invalid',
    'sample-invalid',
    'template-syntax',
    'template-render',
    'template-structure',
    'template-unknown-field',
    'template-unsupported',
    'html-active',
    'html-unsupported',
    'gt-unmarked',
    'gt-type',
    'gt-nested',
    'gt-id',
    'gt-attribute',
    'gt-branch',
    'gt-checkbox',
    'gt-formula',
    'gt-image-text',
    'gt-table',
    'asset-external',
    'asset-path',
    'asset-missing',
    'asset-data',
    'asset-dynamic',
    'css-escape',
    'css-import-cycle',
    'css-page-box',
    'font-unused',
  ];
  const printCodes = [
    'page_count_mismatch',
    'page_box_moved',
    'viewport_dependent',
    'css_animation',
    'layout_unsettled',
    'print_overflow',
    'content_clipped',
    'font_not_loaded',
    'pagination_timeout',
    'row_fragmented',
    'text_missing',
  ];

  test('preview page-count refusals explain the template CSS cause without changing the print code or diagnostic', () => {
    const raw = 'The PDF has a different number of pages than Paged.js made';
    const result = explain({
      code: 'preview_failed',
      message: 'Printing failed',
      details: [{ code: 'page_count_mismatch', message: raw }],
    });
    const issue = result.issues[0];
    expect(issue?.code).toBe('page_count_mismatch');
    expect(issue?.raw).toBe(raw);
    expect(issue?.explanation).toMatch(cjk);
    expect(issue?.explanation).not.toBe(fallback());
    expect(issue?.explanation).toMatch(/\.pagedjs/);
    expect(issue?.explanation).toMatch(/body/i);
    expect(issue?.explanation).toMatch(/頁/);
  });

  test('preview page-box refusals explain CSS moving page elements or html/body and direct authors to @page', () => {
    const raw =
      'page 1 .pagedjs_page margin-top: -75.5906px\nbody at (0.0, -75.6) px, expected (0.0, 0.0)';
    const result = explain({
      code: 'preview_failed',
      message: 'Printing failed',
      details: [{ code: 'page_box_moved', message: raw }],
    });
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue?.code).toBe('page_box_moved');
    expect(issue?.raw).toBe(raw);
    expect(issue?.explanation).toMatch(cjk);
    expect(issue?.explanation).not.toBe(fallback());
    expect(issue?.explanation).toMatch(/CSS/i);
    expect(issue?.explanation).toMatch(/Paged\.js|\.pagedjs/);
    expect(issue?.explanation).toMatch(/html/i);
    expect(issue?.explanation).toMatch(/body/i);
    expect(issue?.explanation).toMatch(/選擇器|body\s*>\s*div/);
    expect(issue?.explanation).toMatch(/移|位置|動到/);
    expect(issue?.explanation).toContain('PDF');
    expect(issue?.explanation).toContain('標準答案');
    expect(issue?.explanation).toContain('@page');
    expect(issue?.explanation).toMatch(/頁邊界|頁面邊界|頁面邊距|頁邊距/);
  });

  test('preview viewport-dependent refusals explain measured box differences, remaining named causes and fixed-page layout advice', () => {
    const raw =
      'print media, 793x1122 vs 794x1123: at 794x1123: 1 75.58,75.58,472.58,115.58';
    const result = explain({
      code: 'preview_failed',
      message: 'Printing failed',
      details: [{ code: 'viewport_dependent', message: raw }],
    });
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue?.code).toBe('viewport_dependent');
    expect(issue?.raw).toBe(raw);
    expect(issue?.explanation).toMatch(cjk);
    expect(issue?.explanation).not.toBe(fallback());
    const text = issue?.explanation;
    // Explain the observed mismatch instead of treating CSS syntax as a denylist.
    expect.soft(text).toContain('data-gt');
    expect.soft(text).toMatch(/框|邊界盒|包圍盒/);
    expect.soft(text).toMatch(/視窗|視埠/);
    expect.soft(text).toMatch(/(?:1|一)\s*(?:px|像素)/i);
    expect.soft(text).toMatch(/分頁/);
    expect.soft(text).toMatch(/不一致|不符|不同|對不上|不吻合|不匹配|差異/);
    // Keep actionable examples of what can move those boxes.
    expect.soft(text).toMatch(/CSS/i);
    expect.soft(text).toMatch(/\bvw\b/i);
    expect.soft(text).toMatch(/\bvh\b/i);
    expect.soft(text).toContain('@media');
    expect.soft(text).toContain('@container');
    expect.soft(text).toMatch(/寬|高/);
    expect.soft(text).toMatch(/\bsizes\b/i);
    // These two causes still have explicit refusals outside the box comparison.
    expect.soft(text).toMatch(/position\s*:\s*fixed/i);
    expect.soft(text).toMatch(/<picture>/i);
    expect.soft(text).toMatch(/\bmedia\b.*選|選.*\bmedia\b/i);
    // Do not present the removed denylist entries as reasons to rewrite a pack.
    expect.soft(text).not.toMatch(/attr\s*\(|\bsrcset\b|\bcontainer-type\b/i);
    expect.soft(text).toMatch(/不要|避免|移除|改用|勿/);
    expect.soft(text).toMatch(/\bmm\b/i);
    expect.soft(text).toMatch(/\bpt\b/i);
    expect.soft(text).toMatch(/\bpx\b/i);
    expect.soft(text).toContain('@page');
    expect.soft(text).toMatch(/頁面大小|紙張大小|紙張尺寸|頁面尺寸/);
    expect.soft(text).toContain('PDF');
    expect.soft(text).toContain('標準答案');
  });

  test('preview css_animation refusals explain animation drift and how to remove its causes', () => {
    const raw = 'div.target: transition width';
    const result = explain({
      code: 'preview_failed',
      message: 'Printing failed',
      details: [{ code: 'css_animation', message: raw }],
    });
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue?.code).toBe('css_animation');
    expect(issue?.raw).toBe(raw);
    expect(issue?.explanation).toMatch(cjk);
    expect(issue?.explanation).not.toBe(fallback());
    expect(issue?.explanation).toContain('動畫');
    expect(issue?.explanation).toContain('轉場');
    expect(issue?.explanation).toMatch(/SVG/i);
    expect(issue?.explanation).toContain('PDF');
    expect(issue?.explanation).toContain('標準答案');
    expect(issue?.explanation).toMatch(/不一致|不符|不同|對不上|不吻合|不匹配/);
    expect(issue?.explanation).toMatch(/移除|停用|關閉|取消|去除|不要|避免|勿/);
  });

  // Regression: without its own explanation the user sees the unknown-code
  // fallback and cannot tell that a resource loading while printing, such as
  // a print-only image or font, made the PDF differ from the ground truth.
  test('preview layout_unsettled refusals explain that the layout changed while printing and how to avoid it', () => {
    const raw = 'data-gt boxes changed while the PDF was printed';
    const result = explain({
      code: 'preview_failed',
      message: 'Printing failed',
      details: [{ code: 'layout_unsettled', message: raw }],
    });
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue?.code).toBe('layout_unsettled');
    expect(issue?.raw).toBe(raw);
    expect(issue?.explanation).toMatch(cjk);
    expect(issue?.explanation).not.toBe(fallback());
    expect(issue?.explanation).toMatch(
      /列印(?:時|過程|期間|當下)|印出(?:時|過程)/,
    );
    expect(issue?.explanation).toMatch(/版面|排版|位置/);
    expect(issue?.explanation).toMatch(/改變|變動|變了|移動|位移|不同/);
    expect(issue?.explanation).toMatch(/載入|讀取/);
    expect(issue?.explanation).toMatch(/圖片|圖檔/);
    expect(issue?.explanation).toMatch(/字型/);
    expect(issue?.explanation).toMatch(/螢幕/);
    expect(issue?.explanation).toMatch(/列印專用|只在列印|僅在列印|只有列印/);
    expect(issue?.explanation).toContain('PDF');
    expect(issue?.explanation).toContain('標準答案');
    expect(issue?.explanation).toMatch(/不一致|不符|不同|對不上|不吻合|不匹配/);
    expect(issue?.explanation).toMatch(/改用|移除|避免|不要|勿|一樣|相同|同樣/);
  });

  // Regression: a print-only size change needs different advice from loading
  // resources or moving page boxes: Paged.js never paginated the larger content.
  test('preview print_overflow refusals explain clipped content, print-only styles and how to keep pagination consistent', () => {
    const raw =
      'Content reaches outside its page only in print, where Paged.js did not paginate';
    const result = explain({
      code: 'preview_failed',
      message: 'Printing failed',
      details: [{ code: 'print_overflow', message: raw }],
    });
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue?.code).toBe('print_overflow');
    expect(issue?.raw).toBe(raw);
    const text = issue?.explanation;
    expect.soft(text).toMatch(cjk);
    expect.soft(text).not.toBe(fallback());
    expect.soft(text).toContain('列印時');
    expect.soft(text).toMatch(/變高|高度|尺寸/);
    expect.soft(text).toMatch(/變寬|寬度|尺寸/);
    expect.soft(text).toMatch(/只在列印|僅在列印|只有列印|列印專用/);
    expect.soft(text).toContain('超出頁面');
    expect.soft(text).toContain('PDF');
    expect.soft(text).toMatch(/裁切|截斷|切掉|切除|漏印|漏掉|少印|遺漏|印不出/);
    expect.soft(text).toContain('標準答案');
    expect.soft(text).toMatch(/不一致|不符|不同|對不上|不吻合|不匹配/);
    expect.soft(text).toContain('data-pagedjs-ignore');
    expect.soft(text).toContain('@media print');
    expect.soft(text).toContain('<body>');
    expect.soft(text).toContain('<style>');
    expect.soft(text).toMatch(/Paged\.js/);
    expect
      .soft(text)
      .toMatch(
        /分頁.{0,30}(?:不會|沒有|未|不套用)|(?:不會|沒有|未).{0,30}分頁/,
      );
    expect.soft(text).toContain('螢幕');
    expect.soft(text).toMatch(/相同|一致|同樣/);
    expect.soft(text).toMatch(/請|改用|移到|放進|放到/);
    expect
      .soft(text)
      .toMatch(/一般.{0,5}樣式表|正常.{0,5}樣式表|樣板包.{0,15}樣式表/);
    expect
      .soft(text)
      .toMatch(/分頁.{0,30}(?:套用|處理)|(?:套用|處理).{0,30}分頁/);
  });

  test('preview content_clipped explains ancestor clipping and gives a fix while preserving the diagnostic', () => {
    const raw = 'page 2 div clipped 50.0px at the bottom';
    const result = explain({
      code: 'preview_failed',
      message: 'Printing failed',
      details: [{ code: 'content_clipped', message: raw }],
    });
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue?.code).toBe('content_clipped');
    expect(issue?.raw).toBe(raw);
    expect.soft(issue?.explanation).toMatch(cjk);
    expect.soft(issue?.explanation).not.toBe(fallback());
    expect.soft(issue?.explanation).toContain('裁');
    expect.soft(issue?.explanation).toMatch(/overflow|祖先|外層/i);
    expect.soft(issue?.explanation).toMatch(/請|移除|調整|增加|改用|避免|不要/);
  });

  test.each([...uploadCodes, ...printCodes])(
    '%s has an actionable Chinese explanation instead of the unknown-code fallback',
    code => {
      const raw = 'Original diagnostic: keep punctuation.\n  More detail';
      const result = invalid([{ code, message: raw }]);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.code).toBe(code);
      expect(result.issues[0]?.raw).toBe(raw);
      expect(result.issues[0]?.explanation).toMatch(cjk);
      expect(result.issues[0]?.explanation).not.toBe(fallback());
      expect(result.issues[0]?.location).toBe(
        uploadCodes.includes(code) ? '整個樣板包' : undefined,
      );
    },
  );

  test('different known causes do not collapse to the same generic Chinese sentence', () => {
    const codes = [...uploadCodes, ...printCodes];
    const explanations = codes.map(
      code => invalid([{ code, message: 'Diagnostic' }]).issues[0]?.explanation,
    );
    expect(new Set(explanations).size).toBe(codes.length);
  });

  test.each<[string, Omit<Detail, 'message'>, string]>([
    [
      'file, line, column and JSON path',
      {
        file: 'manifest.json',
        line: 3,
        column: 5,
        path: ['files', 'styles', 0],
      },
      'manifest.json 第 3 行第 5 欄，欄位 files.styles[0]',
    ],
    [
      'file and line',
      { file: 'templates/report.hbs', line: 7 },
      'templates/report.hbs 第 7 行',
    ],
    ['file alone', { file: 'styles/report.css' }, 'styles/report.css'],
    [
      'file with an empty path',
      { file: 'manifest.json', path: [] },
      'manifest.json',
    ],
    [
      'nested array field',
      { file: 'data/sample.json', path: ['rows', 2, 'amount'] },
      'data/sample.json，欄位 rows[2].amount',
    ],
    [
      'leading array index',
      { file: 'data/sample.json', path: [0, 'a'] },
      'data/sample.json，欄位 [0].a',
    ],
  ])(
    'formats %s so authors can find the problem without reading an object dump',
    (_name, detail, expected) => {
      expect(
        invalid([{ ...detail, code: 'json-syntax', message: 'Bad JSON' }])
          .issues[0]?.location,
      ).toBe(expected);
    },
  );

  test.each<[string, string | undefined]>([
    ['next-code: new diagnostic', undefined],
    ['next_code2: new diagnostic', undefined],
    ['file-missing: Missing stylesheet', undefined],
    ['Plain diagnostic without a code', undefined],
    ['UPPER: not a valid code', undefined],
    ['2code: not a valid code', undefined],
    ['bad.code: not a valid code', undefined],
    ['file-missing:no separating space', undefined],
    [' file-missing: leading space', undefined],
  ])('does not infer an issue code from message text %s', (raw, code) => {
    const issue = invalid([{ message: raw }]).issues[0];
    expect(issue?.code).toBe(code);
    expect(issue?.raw).toBe(raw);
    expect(issue?.explanation).toBe(fallback());
    expect(issue?.explanation).toMatch(cjk);
    if (code === undefined) expect(issue?.location).toBeUndefined();
  });

  test('an explicit code overrides a misleading message prefix without rewriting the raw diagnostic', () => {
    const raw = 'file-missing: This text is only a diagnostic';
    const issue = invalid([{ code: 'manifest-missing', message: raw }])
      .issues[0];
    const expected = invalid([
      { code: 'manifest-missing', message: 'Missing manifest' },
    ]).issues[0];
    expect(issue?.code).toBe('manifest-missing');
    expect(issue?.explanation).toBe(expected?.explanation);
    expect(issue?.explanation).not.toBe(fallback());
    expect(issue?.location).toBe('整個樣板包');
    expect(issue?.raw).toBe(raw);
  });

  test('an unknown explicit code keeps its identity and fallback without borrowing the message code', () => {
    const issue = invalid([
      { code: 'future-code', message: 'file-missing: Missing stylesheet' },
    ]).issues[0];
    expect(issue?.code).toBe('future-code');
    expect(issue?.explanation).toBe(fallback());
    expect(issue?.location).toBeUndefined();
    expect(issue?.raw).toBe('file-missing: Missing stylesheet');
  });

  test('mixed preview diagnostics keep their order and do not inherit the previous code or location', () => {
    const raw = [
      'Some font faces did not load',
      'Font ReportSans failed',
      'Missing text',
    ];
    const result = explain({
      code: 'preview_failed',
      message: 'Printing failed',
      details: raw.map((message, index) => ({
        message,
        ...([0, 2].includes(index)
          ? { code: index === 0 ? 'font_not_loaded' : 'text_missing' }
          : {}),
      })),
    });
    expect(result.issues.map(issue => issue.raw)).toEqual(raw);
    expect(result.issues.map(issue => issue.code)).toEqual([
      'font_not_loaded',
      undefined,
      'text_missing',
    ]);
    expect(result.issues.map(issue => issue.location)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(result.issues[1]?.explanation).toBe(fallback());
  });

  test('invalid-pack title counts all issues rather than displaying a fixed count', () => {
    for (const count of [1, 3, 12]) {
      const result = invalid(
        Array.from({ length: count }, () => ({
          code: 'file-missing',
          message: 'Missing stylesheet',
        })),
      );
      expect(result.title).toMatch(cjk);
      expect(result.title).toMatch(
        new RegExp(`(?:^|[^0-9])${count}(?:[^0-9]|$)`),
      );
      expect(result.issues).toHaveLength(count);
    }
  });

  test('413 without details still tells the author about the 10 MB upload limit', () => {
    const result = explain({
      code: 'template_pack_too_large',
      message: 'Payload too large',
    });
    expect(result.title).toMatch(cjk);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.explanation).toMatch(cjk);
    expect(result.issues[0]?.explanation).toContain('10');
  });

  test('preview, service, missing-template and sign-in failures have distinct Chinese titles and no invented details', () => {
    const codes = [
      'preview_failed',
      'print_unavailable',
      'template_not_found',
      'unauthenticated',
    ];
    const generic = explain({
      code: 'future_error',
      message: 'Unknown failure',
    });
    const anotherGeneric = explain({
      code: 'another_future_error',
      message: 'Different failure',
    });
    expect(generic.title).toMatch(cjk);
    expect(anotherGeneric.title).toBe(generic.title);
    expect(generic.issues).toEqual([]);
    const titles = codes.map(code => {
      const result = explain({ code, message: 'Raw summary' });
      expect(result.title).toMatch(cjk);
      expect(result.title).not.toBe(generic.title);
      expect(result.issues).toEqual([]);
      return result.title;
    });
    expect(new Set(titles).size).toBe(codes.length);
    expect(invalid([]).issues).toEqual([]);
  });
});

describe('stored fixture print errors', () => {
  test.each([
    'page_count_mismatch',
    'page_box_moved',
    'viewport_dependent',
    'css_animation',
    'layout_unsettled',
    'print_overflow',
    'content_clipped',
    'font_not_loaded',
    'pagination_timeout',
    'row_fragmented',
    'text_missing',
  ])(
    'explains the stored %s code with the same guidance as a preview refusal',
    async code => {
      const { explainFixtureError } = await import('./explain.ts');
      expect(
        explainFixtureError,
        'stored fixture explanation is not implemented',
      ).toBeTypeOf('function');
      const expected = explain({
        code: 'preview_failed',
        message: 'Printing failed',
        details: [{ code, message: 'Worker diagnostic' }],
      }).issues[0]?.explanation;
      const actual = explainFixtureError(
        `print 422 ${code}: Worker diagnostic mentions page_count_mismatch`,
      );
      expect(actual).toBe(expected);
      expect(actual).toMatch(cjk);
      expect(actual).not.toBe(fallback());
    },
  );

  test.each([
    'self-check exploded',
    'failed',
    'print 500 future_code: Unknown failure',
    'print 500 print_failed: page_count_mismatch mentioned',
    'self-check exploded: print 422 page_count_mismatch: nested diagnostic',
    'print 422 page_count_mismatch_extra: Unknown code',
  ])('does not invent print guidance for %s', async raw => {
    const { explainFixtureError } = await import('./explain.ts');
    expect(
      explainFixtureError,
      'stored fixture explanation is not implemented',
    ).toBeTypeOf('function');
    expect(explainFixtureError(raw)).toBeUndefined();
  });
});
