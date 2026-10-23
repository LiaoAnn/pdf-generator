// Handlebars filling and template-pack checks, shared by the platform (Worker)
// and the local tools (Node).
export {
  type CheckResult,
  checkPack,
  type Pack,
  type PackFiles,
} from './check.ts';
export { fill, TemplateError } from './fill.ts';
export type { PackIssue } from './issues.ts';
