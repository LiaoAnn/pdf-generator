import {
  type Manifest,
  manifestSchema,
  type Rules,
  rulesSchema,
} from '@pdf-generator/contract';
import { type FakeRecord, recordSchema } from '@pdf-generator/fake-data';
import type { z } from 'zod';
import { type PackFiles, readFiles } from './files.ts';
import { parseTemplate, renderTemplate, TemplateError } from './fill.ts';
import type { PackIssue } from './issues.ts';
import { markIssues } from './marks.ts';
import { decode, jsonPosition, parseJson } from './text.ts';

export type { PackFiles } from './files.ts';

/** A pack that passed every check, parsed. */
export type Pack = {
  manifest: Manifest;
  rules: Rules;
  sample: FakeRecord;
  template: string;
  /** CSS texts, in manifest order. */
  styles: string[];
  /** Every file of the pack, manifest.json included. */
  files: Record<string, Uint8Array>;
};

/** `pack` is present exactly when `ok`. */
export type CheckResult = { ok: boolean; issues: PackIssue[]; pack?: Pack };

type Json = { text: string; value: unknown };

/**
 * Checks a template pack given as zip bytes or as a file map, without touching
 * the file system: the same call runs in a Worker and in Node.
 */
export function checkPack(
  input: Uint8Array | PackFiles,
  { maxBytes }: { maxBytes?: number } = {},
): CheckResult {
  const read = readFiles(input, maxBytes);
  if (!('files' in read)) return { ok: false, issues: [read] };
  const { files } = read;
  const issues = [...read.issues];
  const fail = (): CheckResult => ({ ok: false, issues });

  const text = (file: string): string | undefined => {
    const bytes = files[file];
    if (bytes === undefined) return undefined;
    const decoded = decode(bytes);
    if (decoded === undefined) {
      issues.push({
        code: 'text-encoding',
        file,
        message: 'not valid UTF-8 text',
      });
    }
    return decoded;
  };
  const json = (file: string): Json | undefined => {
    const source = text(file);
    if (source === undefined) return undefined;
    const parsed = parseJson(source, file);
    if ('code' in parsed) {
      issues.push(parsed);
      return undefined;
    }
    return { text: source, value: parsed.value };
  };
  const validate = <T>(
    schema: z.ZodType<T>,
    data: Json,
    file: string,
    code: string,
  ): T | undefined => {
    const result = schema.safeParse(data.value);
    if (result.success) return result.data;
    for (const issue of result.error.issues) {
      const path = issue.path.map(key =>
        typeof key === 'symbol' ? String(key) : key,
      );
      issues.push({
        code,
        file,
        path,
        ...jsonPosition(data.text, path),
        message: issue.message,
      });
    }
    return undefined;
  };

  if (files['manifest.json'] === undefined) {
    const nested = Object.keys(files).find(path =>
      /^[^/]+\/manifest\.json$/.test(path),
    );
    issues.push({
      code: 'manifest-missing',
      file: 'manifest.json',
      message:
        nested === undefined
          ? 'the pack has no manifest.json at its root'
          : `the pack has no manifest.json at its root, but has ${nested}: zip the contents of ${nested.split('/')[0]}/, not the folder`,
    });
    return fail();
  }
  const manifestJson = json('manifest.json');
  const manifest =
    manifestJson &&
    validate(manifestSchema, manifestJson, 'manifest.json', 'manifest-invalid');
  if (manifestJson === undefined || manifest === undefined) return fail();

  const { template, styles, rules, sample, assets = [] } = manifest.files;
  const listed: [string, (string | number)[]][] = [
    [template, ['files', 'template']],
    ...styles.map((path, i): [string, (string | number)[]] => [
      path,
      ['files', 'styles', i],
    ]),
    [rules, ['files', 'rules']],
    [sample, ['files', 'sample']],
    ...assets.map((path, i): [string, (string | number)[]] => [
      path,
      ['files', 'assets', i],
    ]),
  ];
  for (const [path, at] of listed) {
    if (files[path] === undefined) {
      issues.push({
        code: 'file-missing',
        file: 'manifest.json',
        path: at,
        ...jsonPosition(manifestJson.text, at),
        message: `${path} is listed in the manifest but not in the pack`,
      });
    }
  }
  const listedPaths = new Set(['manifest.json', ...listed.map(([p]) => p)]);
  for (const path of Object.keys(files)) {
    if (!listedPaths.has(path)) {
      issues.push({
        code: 'file-unlisted',
        file: path,
        message: `${path} is in the pack but not listed in manifest.json`,
      });
    }
  }

  const templateText = text(template);
  const styleTexts = styles.map(text);
  const rulesJson = json(rules);
  const parsedRules =
    rulesJson && validate(rulesSchema, rulesJson, rules, 'rules-invalid');
  const sampleJson = parsedRules && json(sample);
  const parsedSample =
    parsedRules &&
    sampleJson &&
    validate(recordSchema(parsedRules), sampleJson, sample, 'sample-invalid');

  if (templateText !== undefined) {
    const parsed = parseTemplate(templateText, template);
    issues.push(...parsed.issues);
    if (parsed.ast !== undefined) {
      issues.push(...markIssues(templateText, parsed.ast, template));
      if (parsed.issues.length === 0 && parsedSample !== undefined) {
        try {
          renderTemplate(parsed.ast, parsedSample, template);
        } catch (error) {
          if (!(error instanceof TemplateError)) throw error;
          issues.push(...error.issues);
        }
      }
    }
  }

  if (
    issues.length > 0 ||
    templateText === undefined ||
    parsedRules === undefined ||
    parsedSample === undefined
  ) {
    return fail();
  }
  return {
    ok: true,
    issues,
    pack: {
      manifest,
      rules: parsedRules,
      sample: parsedSample,
      template: templateText,
      styles: styleTexts as string[],
      files,
    },
  };
}
