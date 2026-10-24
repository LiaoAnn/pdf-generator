import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rulesSchema } from '@pdf-generator/contract';
import {
  generate,
  isCalendarDate,
  isValidAddress,
  isValidBusinessId,
  isValidNationalId,
  isValidPhone,
  recordSchema,
} from '@pdf-generator/fake-data';
import { checkPack, fill } from '@pdf-generator/template-tools';
import { type DefaultTreeAdapterMap, parse } from 'parse5';
import { describe, expect, it } from 'vitest';

const directory = fileURLToPath(new URL('../pack/', import.meta.url));
const templateFile = 'templates/incident-form.hbs';
const styleFile = 'styles/incident-form.css';
const text = (file: string) => readFileSync(join(directory, file), 'utf8');
const json = (file: string): unknown => JSON.parse(text(file));

function readPack(): Record<string, Uint8Array> {
  return Object.fromEntries(
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        const path = join(entry.parentPath, entry.name);
        return [
          relative(directory, path).split(sep).join('/'),
          readFileSync(path),
        ];
      }),
  );
}

// These are expectations on delivered data, independent of the pack's rules:
// a wrong rule can otherwise validate its own wrong sample and generated data.
function expectIncidentRecord(value: unknown) {
  expect(value).toMatchObject({
    reportNo: expect.any(Number),
    reportDate: expect.any(String),
    company: expect.any(String),
    businessId: expect.any(String),
    reporter: {
      name: expect.any(String),
      nationalId: expect.any(String),
      department: expect.any(String),
      jobTitle: expect.any(String),
      phone: expect.any(String),
    },
    incident: {
      date: expect.any(String),
      time: expect.any(String),
      address: expect.any(String),
      category: expect.any(String),
      severity: expect.any(String),
      description: expect.stringMatching(/\p{Script=Han}/u),
    },
    hazards: Object.fromEntries(
      ['machinery', 'electrical', 'chemical', 'height', 'fire'].map(key => [
        key,
        expect.any(Boolean),
      ]),
    ),
    actions: Object.fromEntries(
      ['stopWork', 'laborInspection', 'police', 'family'].map(key => [
        key,
        expect.any(Boolean),
      ]),
    ),
    injured: expect.any(Array),
    witness: expect.any(Object),
    approval: expect.any(Object),
  });
  // The assertions above establish the runtime shape before inspecting values.
  const record = value as {
    reportNo: number;
    reportDate: string;
    businessId: string;
    reporter: { nationalId: string; phone: string; extension: number | null };
    incident: {
      date: string;
      address: string;
      category: string;
      severity: string;
      place: string | null;
    };
    hazards: Record<string, boolean>;
    actions: Record<string, boolean>;
    injured: {
      name: string;
      gender: string;
      age: number;
      injury: string;
      hospitalized: boolean;
      note: string | null;
    }[];
    witness: { name: string | null; phone: string | null };
    remarks: string | null;
    approval: { date: string | null };
  };
  expect(Number.isInteger(record.reportNo)).toBe(true);
  expect(isCalendarDate(record.reportDate)).toBe(true);
  expect(isCalendarDate(record.incident.date)).toBe(true);
  expect(isValidBusinessId(record.businessId)).toBe(true);
  expect(isValidNationalId(record.reporter.nationalId)).toBe(true);
  expect(isValidPhone(record.reporter.phone, 'mobile')).toBe(true);
  expect(isValidAddress(record.incident.address)).toBe(true);
  expect([
    '跌倒',
    '墜落',
    '被夾被捲',
    '切割擦傷',
    '感電',
    '化學品接觸',
    '其他',
  ]).toContain(record.incident.category);
  expect(['輕傷', '重傷', '死亡']).toContain(record.incident.severity);
  expect(record.injured.length).toBeGreaterThanOrEqual(1);
  expect(record.injured.length).toBeLessThanOrEqual(8);
  for (const person of record.injured) {
    expect(person).toMatchObject({
      name: expect.any(String),
      injury: expect.any(String),
      hospitalized: expect.any(Boolean),
    });
    expect(['男', '女']).toContain(person.gender);
    expect(Number.isInteger(person.age)).toBe(true);
    expect(person.note === null || typeof person.note === 'string').toBe(true);
  }
  expect(
    record.reporter.extension === null ||
      Number.isInteger(record.reporter.extension),
  ).toBe(true);
  for (const field of [
    record.incident.place,
    record.witness.name,
    record.witness.phone,
    record.remarks,
    record.approval.date,
  ]) {
    expect(field === null || typeof field === 'string').toBe(true);
  }
  if (record.witness.phone !== null) {
    expect(isValidPhone(record.witness.phone, 'mobile')).toBe(true);
  }
  if (record.approval.date !== null) {
    expect(isCalendarDate(record.approval.date)).toBe(true);
  }
  return record;
}

describe('incident form pack, slice 1', () => {
  it('passes the upload pack gate with the incident-form entry points and portrait A4 page', () => {
    const result = checkPack(readPack());
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.pack?.manifest).toMatchObject({
      id: 'incident-form',
      page: { size: 'A4', orientation: 'portrait' },
      files: {
        template: templateFile,
        styles: [styleFile],
        rules: 'data/rules.json',
        sample: 'data/sample.json',
      },
    });
    expect(result.pack?.manifest.files.assets ?? []).toEqual([]);
  });

  it('keeps the preview sample representative of blank fields, both checkbox states and multiple injured people', () => {
    const sample = expectIncidentRecord(json('data/sample.json'));
    const blanks = [
      sample.reporter.extension,
      sample.incident.place,
      ...sample.injured.map(person => person.note),
      sample.witness.name,
      sample.witness.phone,
      sample.remarks,
      sample.approval.date,
    ];
    expect(blanks).toContain(null);
    expect(blanks.some(value => value !== null)).toBe(true);
    const checks = [
      ...Object.values(sample.hazards),
      ...Object.values(sample.actions),
      ...sample.injured.map(person => person.hospitalized),
    ];
    expect(checks).toContain(true);
    expect(checks).toContain(false);
    expect(sample.injured.length).toBeGreaterThanOrEqual(2);
  });

  it('generates valid Taiwanese incident records that fill successfully beyond the hand-picked sample', () => {
    const rules = rulesSchema.parse(json('data/rules.json'));
    const schema = recordSchema(rules);
    const template = text(templateFile);
    for (const seed of [
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '23',
      '42',
      '100',
      '2026',
    ]) {
      const record = generate(rules, seed);
      expect(schema.safeParse(record).success, `seed ${seed}`).toBe(true);
      expectIncidentRecord(record);
      expect(() =>
        fill(template, record, { file: templateFile }),
      ).not.toThrow();
    }
  });

  it('avoids resources and font families that the current print pipeline cannot deliver', () => {
    const template = text(templateFile);
    const document = parse(template);
    const css = [text(styleFile)];
    const visit = (node: DefaultTreeAdapterMap['node']) => {
      if ('tagName' in node) {
        expect(['link', 'img', 'script']).not.toContain(node.tagName);
        for (const attr of node.attrs) {
          expect(['src', 'href']).not.toContain(attr.name);
          if (attr.name === 'style') css.push(attr.value);
          if (attr.name === 'font-family')
            css.push(`font-family:${attr.value};`);
        }
        if (node.tagName === 'style') {
          for (const child of node.childNodes) {
            if ('value' in child) css.push(child.value);
          }
        }
        if ('content' in node) visit(node.content);
      }
      if ('childNodes' in node) node.childNodes.forEach(visit);
    };
    visit(document);
    const allowed = [
      'noto sans tc',
      'noto serif tc',
      'lxgw wenkai tc',
      'noto sans symbols 2',
      'serif',
      'sans-serif',
    ];
    for (const source of css) {
      const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
      expect(clean).not.toMatch(/@font-face\b|@import\b|url\s*\(/i);
      for (const match of clean.matchAll(
        /\b(font-family|font)\s*:\s*([^;}]+)/gi,
      )) {
        let families = match[2] ?? '';
        if (match[1]?.toLowerCase() === 'font') {
          const shorthand =
            /(?:\d*\.)?\d+(?:px|pt|em|rem|%)(?:\s*\/\s*[\d.]+(?:px|pt|em|rem|%)?)?\s+(.+)$/i.exec(
              families,
            );
          expect(
            shorthand,
            `unresolved font shorthand: ${families}`,
          ).not.toBeNull();
          families = shorthand?.[1] ?? '';
        }
        for (const family of families.split(',')) {
          expect(allowed).toContain(
            family
              .replace(/["']/g, '')
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase(),
          );
        }
      }
    }
  });
});
