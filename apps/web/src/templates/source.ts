// Where batches get template packs from: uploaded versions (templateStore in
// store.ts); tests may use the bundled pack (fixture-pack.ts).
import type { Manifest, Rules } from '@pdf-generator/contract';
import type { FakeRecord } from '@pdf-generator/fake-data';
import { Context } from 'effect';

/** The parts of one template version a batch needs to make fixtures. */
export interface TemplatePack {
  manifest: Manifest;
  /** The Handlebars template (manifest.files.template). */
  template: string;
  /** The stylesheets' contents, in manifest.files.styles order. */
  styles: string[];
  /** The fake-data rule file (manifest.files.rules). */
  rules: Rules;
  /** The sample record (manifest.files.sample), which the preview prints. */
  sample: FakeRecord;
  /** Every file of the pack, by pack path, as base64 (what /print takes). */
  files: Record<string, string>;
  /** PostScript names of the pack's own fonts, sorted. */
  fonts: string[];
}

export interface TemplateSourceApi {
  /** The pack of one template version, or undefined if there is none. */
  get: (id: string, version: number) => Promise<TemplatePack | undefined>;
}

export class TemplateSource extends Context.Service<
  TemplateSource,
  TemplateSourceApi
>()('TemplateSource') {}
