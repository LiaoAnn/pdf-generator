// Where batches get template packs from. T15 (template management) stores
// uploaded packs in R2 + D1 and replaces `fixtureTemplates` with a source that
// reads them; until then the only template is the bundled fixture pack.
import type { Manifest, Rules } from '@pdf-generator/contract';
import { Context } from 'effect';
import { fixtureReport } from './fixture-pack.ts';

/** The parts of one template version a batch needs to make fixtures. */
export interface TemplatePack {
  manifest: Manifest;
  /** The Handlebars template (manifest.files.template). */
  template: string;
  /** The stylesheets' contents, in manifest.files.styles order. */
  styles: string[];
  /** The fake-data rule file (manifest.files.rules). */
  rules: Rules;
}

export interface TemplateSourceApi {
  /** The pack of one template version, or undefined if there is none. */
  get: (id: string, version: number) => Promise<TemplatePack | undefined>;
}

export class TemplateSource extends Context.Service<
  TemplateSource,
  TemplateSourceApi
>()('TemplateSource') {}

/** Stub until T15: knows only `fixture-report` version 1. */
export const fixtureTemplates: TemplateSourceApi = {
  get: async (id, version) =>
    id === fixtureReport.manifest.id && version === 1
      ? fixtureReport
      : undefined,
};
