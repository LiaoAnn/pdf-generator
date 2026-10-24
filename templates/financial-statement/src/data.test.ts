import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestSchema, rulesSchema } from '@pdf-generator/contract';
import {
  generate,
  isValidBusinessId,
  recordSchema,
} from '@pdf-generator/fake-data';
import { describe, expect, it } from 'vitest';

const directory = fileURLToPath(new URL('../pack/', import.meta.url));
const json = (file: string): unknown =>
  JSON.parse(readFileSync(join(directory, file), 'utf8'));

type Amounts = {
  q1: number;
  q2: number;
  q3: number;
  q4: number;
  year: number;
  prior: number;
};
type Customer = Amounts & {
  name: string;
  businessId: string;
  share: number;
  priorShare: number;
  ratio: number;
};
type Subtotal = Amounts & { share: number; priorShare: number; ratio: number };
type Region = { name: string; customers: Customer[]; subtotal: Subtotal };
type Statement = {
  company: string;
  businessId: string;
  fiscalYear: number;
  signers: Record<'chairman' | 'manager' | 'accountant' | 'preparer', string>;
  regions: Record<'north' | 'central' | 'south' | 'east', Region>;
  total: Amounts & { ratio: number };
};

const regionKeys = ['north', 'central', 'south', 'east'] as const;
const regionNames = ['北區', '中區', '南區', '東區及離島'];
const quarters = ['q1', 'q2', 'q3', 'q4'] as const;

const rules = rulesSchema.parse(json('data/rules.json'));
const schema = recordSchema(rules);
const seeds = Array.from({ length: 100 }, (_, index) => String(index));
const generated = seeds.map(seed => generate(rules, seed) as Statement);
const sample = json('data/sample.json') as Statement;

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
// The engine rounds to 2 decimals; the printed figure is within half a
// hundredth of the exact quotient.
function expectPercent(actual: number, part: number, whole: number) {
  expect(Number(actual.toFixed(2))).toBe(actual);
  expect(Math.abs(actual - (part / whole) * 100)).toBeLessThanOrEqual(
    0.005 + 1e-9,
  );
}
const customersOf = (record: Statement) =>
  regionKeys.flatMap(key => record.regions[key].customers);

/** Every derived number in the statement equals what its parts say. */
function expectConsistent(record: Statement) {
  const { total } = record;
  for (const key of regionKeys) {
    const { customers, subtotal } = record.regions[key];
    for (const customer of customers) {
      expect(customer.year).toBe(sum(quarters.map(q => customer[q])));
      expectPercent(customer.share, customer.year, total.year);
      expectPercent(customer.priorShare, customer.prior, total.prior);
      expectPercent(customer.ratio, customer.year, customer.prior);
    }
    for (const field of [...quarters, 'year', 'prior'] as const)
      expect(subtotal[field], `${key} subtotal ${field}`).toBe(
        sum(customers.map(customer => customer[field])),
      );
    expectPercent(subtotal.share, subtotal.year, total.year);
    expectPercent(subtotal.priorShare, subtotal.prior, total.prior);
    expectPercent(subtotal.ratio, subtotal.year, subtotal.prior);
  }
  for (const field of [...quarters, 'year', 'prior'] as const)
    expect(total[field], `total ${field}`).toBe(
      sum(regionKeys.map(key => record.regions[key].subtotal[field])),
    );
  expect(total.year).toBe(sum(quarters.map(q => total[q])));
  expectPercent(total.ratio, total.year, total.prior);
}

describe('financial statement pack data, slice 1', () => {
  it('declares a landscape A4 pack whose rules and sample are the packaged data files', () => {
    const manifest = manifestSchema.parse(json('manifest.json'));
    // Landscape is what fits the 8-column, three-level header; a portrait or
    // missing orientation would print the table cramped or cut off.
    expect(manifest).toMatchObject({
      id: 'financial-statement',
      name: '客戶別銷貨明細表',
      page: { size: 'A4', orientation: 'landscape' },
      files: {
        rules: 'data/rules.json',
        sample: 'data/sample.json',
        assets: [],
      },
    });
  });

  it('generates the same statement for the same seed and different ones across seeds', () => {
    // A hidden unseeded source would break batch reproducibility.
    for (const seed of ['0', '7', '2026'])
      expect(generate(rules, seed)).toEqual(generate(rules, seed));
    const serialized = new Set(generated.map(record => JSON.stringify(record)));
    expect(serialized.size).toBe(seeds.length);
    // Not just the names: amounts and the header facts must vary too.
    expect(
      new Set(generated.map(record => record.total.year)).size,
    ).toBeGreaterThan(90);
    expect(
      new Set(generated.map(record => record.fiscalYear)).size,
    ).toBeGreaterThan(1);
  });

  it('keeps the four regions in print order with their fixed names and 2–12 customers each, varying by seed', () => {
    // The table prints regions in object order; a reordered or renamed region
    // would mislabel its rows in the ground truth.
    for (const record of [sample, ...generated]) {
      expect(Object.keys(record.regions)).toEqual([...regionKeys]);
      expect(regionKeys.map(key => record.regions[key].name)).toEqual(
        regionNames,
      );
      expect(Object.keys(record.signers)).toEqual([
        'chairman',
        'manager',
        'accountant',
        'preparer',
      ]);
    }
    const counts = generated.flatMap(record =>
      regionKeys.map(key => record.regions[key].customers.length),
    );
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...counts)).toBeLessThanOrEqual(12);
    // A fixed count would never exercise a table that runs across pages.
    expect(new Set(counts).size).toBeGreaterThanOrEqual(6);
    // Long statements must exist to force pagination with a repeated header.
    expect(
      Math.max(...generated.map(record => customersOf(record).length)),
    ).toBeGreaterThanOrEqual(25);
  });

  it('derives every subtotal, total, share and ratio from the customer amounts in every seeded record', () => {
    // A derived column drawn independently of its parts (or with a wrong
    // whole or scope) would put numbers on the page that do not add up.
    for (const [index, record] of generated.entries()) {
      try {
        expectConsistent(record);
      } catch (error) {
        throw new Error(`seed ${index}: ${(error as Error).message}`);
      }
    }
  });

  it('draws valid identifiers and amounts in range for every generated customer and header', () => {
    for (const record of generated) {
      expect(isValidBusinessId(record.businessId)).toBe(true);
      expect(record.fiscalYear).toBeGreaterThanOrEqual(110);
      expect(record.fiscalYear).toBeLessThanOrEqual(114);
      for (const customer of customersOf(record)) {
        expect(isValidBusinessId(customer.businessId)).toBe(true);
        for (const quarter of quarters) {
          expect(Number.isInteger(customer[quarter])).toBe(true);
          expect(customer[quarter]).toBeGreaterThanOrEqual(500_000);
          expect(customer[quarter]).toBeLessThanOrEqual(1_250_000);
        }
        expect(Number.isInteger(customer.prior)).toBe(true);
        expect(customer.prior).toBeGreaterThanOrEqual(2_500_000);
        expect(customer.prior).toBeLessThanOrEqual(4_500_000);
      }
    }
    // Customer names are drawn per customer, not copied from the header or a
    // constant. The engine's company pool is only 768 names, so repeats across
    // 100 seeds are expected (about 740 distinct of ~2800 draws); a constant or
    // header copy would give 1 distinct name per record.
    const names = generated.flatMap(record =>
      customersOf(record).map(c => c.name),
    );
    expect(new Set(names).size).toBeGreaterThanOrEqual(500);
    for (const record of generated) {
      const own = customersOf(record).map(c => c.name);
      expect(own.some(name => name !== record.company)).toBe(true);
      expect(new Set(own).size).toBeGreaterThan(1);
    }
  });

  it('ships a sample the rules could produce and whose numbers are consistent', () => {
    // The upload sample must match what batches print, and be self-consistent
    // so the sample fixture's ground truth is not wrong.
    expect(schema.safeParse(sample).success).toBe(true);
    for (const record of generated)
      expect(schema.safeParse(record).success).toBe(true);
    expectConsistent(sample);
    expect(isValidBusinessId(sample.businessId)).toBe(true);
    for (const customer of customersOf(sample))
      expect(isValidBusinessId(customer.businessId)).toBe(true);
    for (const key of regionKeys) {
      const count = sample.regions[key].customers.length;
      expect(count).toBeGreaterThanOrEqual(2);
      expect(count).toBeLessThanOrEqual(12);
    }
  });
});
