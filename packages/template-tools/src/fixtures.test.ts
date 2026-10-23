import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidBusinessId, isValidNationalId } from '@pdf-generator/fake-data';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { checkPack, type PackIssue } from './index.ts';

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
const broken = readdirSync(join(fixtures, 'broken')).sort();

function readPack(directory: string): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  function visit(relative: string) {
    for (const entry of readdirSync(join(directory, relative), {
      withFileTypes: true,
    })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path);
      else files[path] = readFileSync(join(directory, path));
    }
  }
  visit('');
  return files;
}

describe('committed template pack acceptance corpus', () => {
  it('retains exactly ten independently broken packs instead of losing acceptance cases', () => {
    expect(broken).toHaveLength(10);
    const valid = readPack(join(fixtures, 'valid'));
    for (const slug of broken) {
      const pack = readPack(join(fixtures, 'broken', slug, 'pack'));
      expect(Object.keys(pack).sort()).toEqual(Object.keys(valid).sort());
      const changed = Object.entries(valid).filter(
        ([file, bytes]) =>
          !Buffer.from(bytes).equals(Buffer.from(pack[file] ?? [])),
      );
      expect(changed, slug).toHaveLength(1);
    }
  });

  it('keeps the positive control usable as both directory bytes and zip bytes', () => {
    const files = readPack(join(fixtures, 'valid'));
    const sample = JSON.parse(
      new TextDecoder().decode(files['data/sample.json']),
    );
    expect(isValidNationalId(sample.nationalId)).toBe(true);
    expect(isValidBusinessId(sample.businessId)).toBe(true);
    for (const input of [files, zipSync(files)]) {
      const result = checkPack(input);
      expect(result.ok).toBe(true);
      expect(result.issues).toEqual([]);
      expect(result.pack?.manifest.id).toBe('taiwan-monthly-report');
    }
  });

  describe.each(broken)('%s', slug => {
    const directory = join(fixtures, 'broken', slug);
    const expected = JSON.parse(
      readFileSync(join(directory, 'expected.json'), 'utf8'),
    ) as { description: string; issues: Omit<PackIssue, 'message'>[] };

    it.each(['file map', 'zip'])(
      `catches ${expected.description} with exact source locations via %s`,
      format => {
        const files = readPack(join(directory, 'pack'));
        const result = checkPack(format === 'zip' ? zipSync(files) : files);
        expect(result.ok).toBe(false);
        expect(result).not.toHaveProperty('pack');
        expect(
          result.issues.map(({ message, ...issue }) => {
            expect(message.trim().length).toBeGreaterThan(0);
            return issue;
          }),
        ).toEqual(expected.issues);
      },
    );
  });
});
