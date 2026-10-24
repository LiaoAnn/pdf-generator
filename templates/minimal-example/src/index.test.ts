import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestSchema, rulesSchema } from '@pdf-generator/contract';
import { wordCss } from '@pdf-generator/pack-spec';
import { checkPack, fill, type PackFiles } from '@pdf-generator/template-tools';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { packFiles, packZip } from './index.ts';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const decoder = new TextDecoder();

function text(files: PackFiles, path: string): string {
  const value = files[path];
  expect(value, `missing pack file: ${path}`).toBeInstanceOf(Uint8Array);
  return decoder.decode(value as Uint8Array);
}

function manifestOf(files: PackFiles) {
  return manifestSchema.parse(JSON.parse(text(files, 'manifest.json')));
}

describe('minimal example for pack authors', () => {
  it('lets an author run the documented check-pack command successfully', () => {
    const result = spawnSync('pnpm', ['check-pack'], {
      cwd: packageDir,
      env: { ...process.env, INIT_CWD: packageDir },
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('ok: minimal-example');
  });

  it('passes the platform checker with zero issues as both files and an upload zip', () => {
    for (const input of [packFiles(), packZip()]) {
      const result = checkPack(input);
      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.pack).toBeDefined();
    }
    const files = packFiles();
    const manifest = manifestOf(files);
    expect(manifest.id).toBe('minimal-example');
    expect(manifest.page).toEqual({ size: 'A4', orientation: 'portrait' });
    rulesSchema.parse(JSON.parse(text(files, manifest.files.rules)));
    // checkPack above also validates the sample record against these rules.
  });

  it('ships every on-disk pack file unchanged at the zip root', () => {
    const files = packFiles();
    const directory = join(packageDir, 'pack');
    const diskFiles = Object.fromEntries(
      readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => {
          const path = join(entry.parentPath, entry.name);
          return [
            relative(directory, path).replaceAll('\\', '/'),
            new Uint8Array(readFileSync(path)),
          ];
        }),
    );
    expect(files).toEqual(diskFiles);
    const entries = unzipSync(packZip());
    expect(entries).toHaveProperty('manifest.json');
    expect(entries).toEqual(files);
  });

  it('applies a byte-identical copy of canonical Word CSS before example styles', () => {
    const files = packFiles();
    const manifest = manifestOf(files);
    expect(manifest.files.styles.length).toBeGreaterThanOrEqual(2);
    expect(files[manifest.files.styles[0] ?? '']).toEqual(
      new TextEncoder().encode(wordCss()),
    );
    for (const path of manifest.files.styles.slice(1)) {
      expect(text(files, path).trim().length).toBeGreaterThan(0);
    }
  });

  it('uses platform font families without bundling or defining fonts', () => {
    const files = packFiles();
    const allowed = new Set([
      'Noto Sans TC',
      'Noto Serif TC',
      'LXGW WenKai TC',
      'Noto Sans Symbols 2',
      'serif',
      'sans-serif',
      'monospace',
      'cursive',
      'fantasy',
      'system-ui',
      'ui-serif',
      'ui-sans-serif',
      'ui-monospace',
      'ui-rounded',
      'emoji',
      'math',
      'fangsong',
    ]);
    expect(
      Object.keys(files).filter(path =>
        /\.(?:woff2?|ttf|otf|eot|ttc)$/i.test(path),
      ),
    ).toEqual([]);
    for (const path of Object.keys(files).filter(path =>
      path.endsWith('.css'),
    )) {
      const css = text(files, path).replace(/\/\*[\s\S]*?\*\//g, '');
      expect(css).not.toMatch(/@font-face\b/i);
      for (const declaration of css.matchAll(
        /\bfont-family\s*:\s*([^;}]+)/gi,
      )) {
        for (const family of (declaration[1] ?? '').split(',')) {
          const name = family.trim().replace(/^(['"])(.*)\1$/, '$2');
          expect(allowed.has(name), `${path}: unsupported font ${name}`).toBe(
            true,
          );
        }
      }
    }
  });

  it('demonstrates the required ground-truth blocks and a checkbox inside a table cell', () => {
    const files = packFiles();
    const manifest = manifestOf(files);
    const template = text(files, manifest.files.template);
    expect(template).toMatch(/<\/head\s*>/i);
    const html = fill(
      template,
      JSON.parse(text(files, manifest.files.sample)),
      {
        file: manifest.files.template,
      },
    ).replace(/<!--[\s\S]*?-->/g, '');
    const types = [...html.matchAll(/\bdata-gt\s*=\s*['"]([^'"]+)['"]/gi)].map(
      match => match[1],
    );
    expect(types).toEqual(
      expect.arrayContaining([
        'title',
        'heading',
        'paragraph',
        'label',
        'field',
        'table',
        'checkbox',
        'page_footer',
      ]),
    );
    const cells = [...html.matchAll(/<td\b[^>]*>[\s\S]*?<\/td\s*>/gi)].map(
      match => match[0],
    );
    expect(cells.some(cell => /\bdata-gt-checked\s*=/.test(cell))).toBe(true);
  });
});
