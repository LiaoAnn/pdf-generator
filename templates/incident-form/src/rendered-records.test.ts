import { readFileSync } from 'node:fs';
import { rulesSchema } from '@pdf-generator/contract';
import { generate } from '@pdf-generator/fake-data';
import { fill } from '@pdf-generator/template-tools';
import { type DefaultTreeAdapterMap, parse } from 'parse5';
import { describe, expect, it } from 'vitest';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type IncidentRecord = {
  reportDate: string;
  company: string;
  businessId: string;
  reporter: {
    name: string;
    nationalId: string;
    department: string;
    jobTitle: string;
    phone: string;
    extension: number | null;
  };
  incident: {
    date: string;
    time: string;
    address: string;
    place: string | null;
    category: string;
    severity: string;
    description: string;
  };
  hazards: Record<
    'machinery' | 'electrical' | 'chemical' | 'height' | 'fire',
    boolean
  >;
  actions: Record<
    'stopWork' | 'laborInspection' | 'police' | 'family',
    boolean
  >;
  witness: { name: string | null; phone: string | null };
  remarks: string | null;
  approval: { date: string | null };
  injured: {
    name: string;
    gender: string;
    age: number;
    injury: string;
    hospitalized: boolean;
    note: string | null;
  }[];
};

const read = (file: string) =>
  readFileSync(new URL(`../pack/${file}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('manifest.json')) as {
  files: { template: string; rules: string };
};
const rules = rulesSchema.parse(JSON.parse(read(manifest.files.rules)));
const template = read(manifest.files.template);
const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim();
const printed = (value: string | number | null) =>
  normalize(value === null ? '' : String(value));
const rocText = (iso: string | null): string => {
  if (iso === null) return '';
  const [year = 0, month = 0, day = 0] = iso.split('-').map(Number);
  return `民國${year - 1911}年${month}月${day}日`;
};

function rawText(node: Node): string {
  if ('value' in node && node.nodeName === '#text') return node.value;
  if ('tagName' in node && node.tagName === 'br') return '\n';
  return 'childNodes' in node ? node.childNodes.map(rawText).join('') : '';
}

const text = (node: Node) => normalize(rawText(node));
const attr = (node: Element, name: string) =>
  node.attrs.find(attribute => attribute.name === name)?.value;

function elements(
  node: Node,
  matches: (element: Element) => boolean,
): Element[] {
  const found: Element[] = [];
  if ('tagName' in node && matches(node)) found.push(node);
  if ('childNodes' in node) {
    for (const child of node.childNodes)
      found.push(...elements(child, matches));
  }
  return found;
}

const tagged = (node: Node, tag: string) =>
  elements(node, element => element.tagName === tag);

function valueCell(form: Element, label: string): Element {
  const matches = elements(
    form,
    element =>
      element.tagName === 'td' &&
      (attr(element, 'class') ?? '').split(/\s+/u).includes('label') &&
      (label === '危害因素' || label === '已採取措施'
        ? text(element).startsWith(label)
        : text(element) === label),
  );
  expect(matches, `unique label ${label}`).toHaveLength(1);
  const labelCell = matches[0];
  if (!labelCell?.parentNode) throw new Error(`Missing label ${label}`);
  const cells = tagged(labelCell.parentNode, 'td');
  const value = cells[cells.indexOf(labelCell) + 1];
  if (!value) throw new Error(`Missing value cell after ${label}`);
  return value;
}

const fixtures = Array.from({ length: 100 }, (_, index) => {
  const seed = `t23-slice2-${index}`;
  const data = generate(rules, seed);
  const document = parse(
    fill(template, data, { file: manifest.files.template }),
  );
  const tables = elements(
    document,
    element =>
      element.tagName === 'table' && attr(element, 'data-gt') === 'table',
  );
  const form = tables.find(table => attr(table, 'class') === 'form');
  const list = tables.find(table => attr(table, 'class') === 'list');
  if (!form || !list) throw new Error(`Missing form/list table for ${seed}`);
  return {
    seed,
    record: data as unknown as IncidentRecord,
    document,
    form,
    list,
  };
});

function groups(record: IncidentRecord): [string, [string, boolean][]][] {
  return [
    [
      '事故類型',
      [
        '跌倒',
        '墜落',
        '被夾被捲',
        '切割擦傷',
        '感電',
        '化學品接觸',
        '其他',
      ].map(label => [label, record.incident.category === label]),
    ],
    [
      '傷害程度',
      ['輕傷', '重傷', '死亡'].map(label => [
        label,
        record.incident.severity === label,
      ]),
    ],
    [
      '危害因素',
      [
        ['機械設備', record.hazards.machinery],
        ['電氣', record.hazards.electrical],
        ['化學物質', record.hazards.chemical],
        ['高處作業', record.hazards.height],
        ['火災爆炸', record.hazards.fire],
      ],
    ],
    [
      '已採取措施',
      [
        ['停工', record.actions.stopWork],
        ['通報勞動檢查機構', record.actions.laborInspection],
        ['報警', record.actions.police],
        ['通知家屬', record.actions.family],
      ],
    ],
  ];
}

function formValues(
  record: IncidentRecord,
): [string, string | number | null][] {
  return [
    ['事業單位', record.company],
    ['統一編號', record.businessId],
    ['通報人', record.reporter.name],
    ['身分證字號', record.reporter.nationalId],
    ['部門', record.reporter.department],
    ['職稱', record.reporter.jobTitle],
    ['聯絡電話', record.reporter.phone],
    ['分機', record.reporter.extension],
    ['發生日期', rocText(record.incident.date)],
    ['發生時間', record.incident.time],
    ['地址', record.incident.address],
    ['場所', record.incident.place],
    ['事故經過', record.incident.description],
    ['目擊者', record.witness.name],
    ['目擊者電話', record.witness.phone],
    ['備註', record.remarks],
    ['簽核日期', rocText(record.approval.date)],
    ['主管簽章', null],
  ];
}

function expectCheckboxes(cell: Element, options: [string, boolean][]) {
  const boxes = elements(
    cell,
    element => attr(element, 'data-gt-checked') !== undefined,
  );
  expect(boxes).toHaveLength(options.length);
  options.forEach(([label, checked], index) => {
    const box = boxes[index];
    if (!box?.parentNode) throw new Error(`Missing checkbox for ${label}`);
    expect(attr(box, 'data-gt-checked'), label).toBe(String(checked));
    expect(text(box), label).toBe(checked ? '☑' : '☐');
    const siblings = box.parentNode.childNodes;
    expect(
      normalize(
        siblings
          .slice(siblings.indexOf(box) + 1)
          .map(rawText)
          .join(''),
      ),
    ).toBe(label);
  });
}

describe('incident form ROC dates', () => {
  const sample = JSON.parse(read('data/sample.json')) as IncidentRecord;
  const render = (record: IncidentRecord) =>
    parse(fill(template, record, { file: manifest.files.template }));
  const formIn = (document: Node) => {
    const form = elements(
      document,
      element =>
        element.tagName === 'table' && attr(element, 'class') === 'form',
    )[0];
    if (!form) throw new Error('Missing form table');
    return form;
  };
  const reportText = (document: Node) =>
    elements(
      document,
      element =>
        element.tagName === 'p' &&
        attr(element, 'data-gt') === 'field' &&
        text(element).startsWith('通報日期：'),
    ).map(text);

  it.each([
    ['2026-07-09', '民國115年7月9日'],
    ['2025-11-23', '民國114年11月23日'],
  ])(
    'prints full ROC report date for %s without changing ISO input',
    (iso, expected) => {
      const record = { ...sample, reportDate: iso };
      const before = structuredClone(record);
      const document = render(record);
      expect(record).toEqual(before);
      expect(reportText(document)).toEqual([`通報日期：中華${expected}`]);
    },
  );

  it.each([
    ['發生日期', '2026-07-09', '民國115年7月9日'],
    ['發生日期', '2025-11-23', '民國114年11月23日'],
    ['簽核日期', '2026-07-09', '民國115年7月9日'],
    ['簽核日期', '2025-11-23', '民國114年11月23日'],
  ])(
    'prints text ROC %s for %s without changing ISO input',
    (label, iso, expected) => {
      const record = {
        ...sample,
        incident: { ...sample.incident, date: iso },
        approval: { date: iso },
      };
      const before = structuredClone(record);
      const document = render(record);
      expect(record).toEqual(before);
      expect(text(valueCell(formIn(document), label))).toBe(expected);
    },
  );

  it('leaves a null approval date cell empty instead of printing a ROC prefix or null', () => {
    const record = { ...sample, approval: { date: null } };
    expect(text(valueCell(formIn(render(record)), '簽核日期'))).toBe('');
  });

  it('prints each generated report date as full ROC text in its ground-truth header', () => {
    for (const { seed, record, document } of fixtures) {
      expect(reportText(document), seed).toEqual([
        `通報日期：中華${rocText(record.reportDate)}`,
      ]);
    }
  });
});

describe('incident form generated records, slice 2', () => {
  it('does not collapse a 100-seed batch to a fixed injured-row count', () => {
    expect(
      new Set(fixtures.map(({ record }) => record.injured.length)).size,
    ).toBeGreaterThan(1);
  });

  it('exercises both states of every checkbox option across 100 seeds', () => {
    const states = new Map<string, Set<boolean>>();
    for (const { record } of fixtures) {
      const options = groups(record).flatMap(([group, entries]) =>
        entries.map(([label, checked]): [string, boolean] => [
          `${group}/${label}`,
          checked,
        ]),
      );
      options.push(
        ...record.injured.map((person): [string, boolean] => [
          'injured.hospitalized',
          person.hospitalized,
        ]),
      );
      for (const [key, checked] of options) {
        const seen = states.get(key) ?? new Set<boolean>();
        seen.add(checked);
        states.set(key, seen);
      }
    }
    for (const [key, seen] of states)
      expect(seen, key).toEqual(new Set([true, false]));
  });

  it('exercises blank and populated values for every blankable field across 100 seeds', () => {
    const values = new Map<string, Set<boolean>>();
    for (const { record } of fixtures) {
      const fields: [string, unknown][] = [
        ['reporter.extension', record.reporter.extension],
        ['incident.place', record.incident.place],
        ['witness.name', record.witness.name],
        ['witness.phone', record.witness.phone],
        ['remarks', record.remarks],
        ['approval.date', record.approval.date],
        ...record.injured.map((person): [string, unknown] => [
          'injured.note',
          person.note,
        ]),
      ];
      for (const [key, value] of fields) {
        const seen = values.get(key) ?? new Set<boolean>();
        seen.add(value === null);
        values.set(key, seen);
      }
    }
    for (const [key, seen] of values)
      expect(seen, key).toEqual(new Set([true, false]));
  });

  it('prints each form value in its labeled cell and leaves nulls and the signature cell empty', () => {
    for (const { seed, record, form } of fixtures) {
      for (const [label, value] of formValues(record)) {
        expect(text(valueCell(form, label)), `${seed}: ${label}`).toBe(
          printed(value),
        );
      }
    }
  });

  it('keeps every form checkbox attribute, printed glyph and option label aligned with its record', () => {
    for (const { record, form } of fixtures) {
      for (const [label, options] of groups(record)) {
        expectCheckboxes(valueCell(form, label), options);
      }
    }
  });

  it('renders exactly the injured people in order with matching hospitalization checks and empty null notes', () => {
    for (const { seed, record, list } of fixtures) {
      const body = tagged(list, 'tbody')[0];
      if (!body) throw new Error(`Missing injured tbody for ${seed}`);
      const rows = tagged(body, 'tr');
      expect(rows, seed).toHaveLength(record.injured.length);
      record.injured.forEach((person, index) => {
        const row = rows[index];
        if (!row) throw new Error(`Missing injured row ${index} for ${seed}`);
        const cells = tagged(row, 'td');
        expect(cells, `${seed}: injured ${index}`).toHaveLength(6);
        expect(cells.map(text).slice(0, 4)).toEqual(
          [person.name, person.gender, person.age, person.injury].map(printed),
        );
        const hospital = cells[4];
        const note = cells[5];
        if (!hospital || !note)
          throw new Error('Missing hospitalization/note cells');
        expectCheckboxes(hospital, [
          ['是', person.hospitalized],
          ['否', !person.hospitalized],
        ]);
        expect(text(note), `${seed}: injured ${index} note`).toBe(
          printed(person.note),
        );
      });
    }
  });
});
