// A small, fixed template pack (one A4 page of Taiwanese customer data) for
// batch tests: as a template source, or stored as an uploaded version.
import { Buffer } from 'node:buffer';
import type { Manifest, Rules } from '@pdf-generator/contract';
import type { FakeRecord } from '@pdf-generator/fake-data';
import { drizzle } from 'drizzle-orm/d1';
import { strToU8, zipSync } from 'fflate';
import * as schema from '../db/schema.ts';
import type { TemplatePack, TemplateSourceApi } from './source.ts';
import { saveVersion } from './store.ts';

const template = `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<title>客戶基本資料表</title>
</head>
<body>
<h1 data-gt="title">{{company}} 客戶基本資料表</h1>
<p data-gt="paragraph">統一編號：{{businessId}}</p>
<h2 data-gt="heading">一、聯絡人</h2>
<div class="row"><span data-gt="label">姓名</span><span data-gt="field">{{contact.name}}</span></div>
<div class="row"><span data-gt="label">身分證字號</span><span data-gt="field">{{contact.nationalId}}</span></div>
<div class="row"><span data-gt="label">行動電話</span><span data-gt="field">{{contact.mobile}}</span></div>
<div class="row"><span data-gt="label">通訊地址</span><span data-gt="field">{{contact.address}}</span></div>
<h2 data-gt="heading">二、往來資訊</h2>
<div class="row"><span data-gt="label">開戶日期</span><span data-gt="field">{{openedOn}}</span></div>
<div class="row"><span data-gt="label">信用額度（新臺幣）</span><span data-gt="field">{{creditLimit}}</span></div>
<p data-gt="paragraph">本表所載資料均為測試用假資料，與真實人物、公司無關。</p>
</body>
</html>
`;

const styles = `@page { size: A4; margin: 20mm 18mm; }
html { font-family: "Noto Sans TC", sans-serif; font-size: 11pt; line-height: 1.6; }
h1 { font-size: 18pt; font-weight: 700; margin: 0 0 6mm; }
h2 { font-size: 13pt; font-weight: 700; margin: 6mm 0 2mm; }
p { margin: 0 0 3mm; }
.row { display: flex; gap: 6mm; margin: 0 0 2mm; }
.row [data-gt="label"] { width: 40mm; font-weight: 700; }
`;

const manifest: Manifest = {
  schemaVersion: 1,
  id: 'fixture-report',
  name: '客戶基本資料表（測試樣板）',
  description: 'T16 的固定樣板，批次測試用。',
  page: { size: 'A4', orientation: 'portrait' },
  files: {
    template: 'template.hbs',
    styles: ['styles.css'],
    rules: 'rules.json',
    sample: 'sample.json',
  },
};

const rules: Rules = {
  schemaVersion: 1,
  fields: {
    company: { type: 'company' },
    businessId: { type: 'businessId' },
    contact: {
      type: 'object',
      fields: {
        name: { type: 'name', gender: 'any' },
        nationalId: { type: 'nationalId', gender: 'any' },
        mobile: { type: 'phone', kind: 'mobile' },
        address: { type: 'address' },
      },
    },
    openedOn: { type: 'date', min: '2020-01-01', max: '2026-09-30' },
    creditLimit: { type: 'money', min: 100000, max: 5000000 },
  },
};

const sample: FakeRecord = {
  company: '青禾測試股份有限公司',
  businessId: '04595257',
  contact: {
    name: '王小明',
    nationalId: 'A123456789',
    mobile: '0912-345-678',
    address: '100臺北市中正區重慶南路一段122號',
  },
  openedOn: '2024-03-15',
  creditLimit: 1200000,
};

const json = (value: unknown) => strToU8(JSON.stringify(value));

// The pack's files, as its zip holds them.
const packFiles: Record<string, Uint8Array> = {
  'manifest.json': json(manifest),
  [manifest.files.template]: strToU8(template),
  ...Object.fromEntries(
    manifest.files.styles.map(path => [path, strToU8(styles)]),
  ),
  [manifest.files.rules]: json(rules),
  [manifest.files.sample]: json(sample),
};

export const fixtureReport: TemplatePack = {
  manifest,
  template,
  rules,
  sample,
  files: Object.fromEntries(
    Object.entries(packFiles).map(([path, bytes]) => [
      path,
      Buffer.from(bytes).toString('base64'),
    ]),
  ),
  fonts: [],
};

/** Knows only `fixture-report` version 1. */
export const fixtureTemplates: TemplateSourceApi = {
  get: async (id, version) =>
    id === fixtureReport.manifest.id && version === 1
      ? fixtureReport
      : undefined,
};

/** Stores the pack as version 1 of `fixture-report`, as an upload would. */
export async function storeFixturePack(env: Env): Promise<void> {
  const zip = zipSync(packFiles);
  await saveVersion(drizzle(env.DB, { schema }), env.FILES, manifest, zip);
}
