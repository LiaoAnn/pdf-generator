// An eval-free interpreter for the Handlebars subset template packs may use.
// workerd forbids code generation from strings, so Handlebars.compile cannot
// run there; Handlebars.parse can, and this walks its AST. Real Handlebars is
// the reference for the output (fill.test.ts compares the two).
import Handlebars from 'handlebars';
import type { PackIssue } from './issues.ts';

type AST = hbs.AST.Program;
type Node = hbs.AST.Node;
type Statement = hbs.AST.Statement;
type Expression = hbs.AST.Expression;
type Path = hbs.AST.PathExpression;
type Call = {
  path: Path;
  params: Expression[];
  hash: hbs.AST.Hash;
  loc: hbs.AST.SourceLocation;
};

/** The template cannot be filled; every issue is located in the template. */
export class TemplateError extends Error {
  override readonly name = 'TemplateError';
  readonly issues: PackIssue[];
  constructor(issues: PackIssue[]) {
    super(
      issues
        .map(
          ({ file, line, column, message }) =>
            `${file}:${line ?? '?'}:${column ?? '?'}: ${message}`,
        )
        .join('; '),
    );
    this.issues = issues;
  }
}

/** Block helpers a template may use. */
const blockHelpers = new Set(['if', 'unless', 'each', 'with']);
/** `rocDate` formats, by the name a template passes as format=. */
const rocFormats: Record<string, (y: number, m: number, d: number) => string> =
  {
    text: (y, m, d) => `民國${y}年${m}月${d}日`,
    full: (y, m, d) => `中華民國${y}年${m}月${d}日`,
    slash: (y, m, d) => `${y}/${pad(m)}/${pad(d)}`,
    dot: (y, m, d) => `${y}.${pad(m)}.${pad(d)}`,
    year: y => String(y),
    month: (_y, m) => String(m),
    day: (_y, _m, d) => String(d),
  };
const pad = (value: number) => String(value).padStart(2, '0');

/**
 * Inline helpers a template may use, with the hash keys each accepts and, for
 * a key in `choices`, the quoted names it may take.
 */
const inlineHelpers: Record<
  string,
  { params: number; hash: string[]; choices?: Record<string, string[]> }
> = {
  eq: { params: 2, hash: [] },
  lookup: { params: 2, hash: [] },
  number: { params: 1, hash: ['decimals'] },
  rocDate: {
    params: 1,
    hash: ['format'],
    choices: { format: Object.keys(rocFormats) },
  },
};
const dataVariables = new Set(['root', 'index', 'key', 'first', 'last']);
/** Most statements one fill may evaluate, and most characters it may print. */
const maxSteps = 1_000_000;
const maxOutput = 16 * 1024 * 1024;

const at = (file: string, node: Node) => ({
  file,
  line: node.loc.start.line,
  column: node.loc.start.column + 1,
});

/** A helper call rather than a field lookup, as Handlebars decides it. */
const isSimpleName = (path: Path) =>
  path.parts.length === 1 &&
  !path.data &&
  path.depth === 0 &&
  !/^\.|^this\b/.test(path.original);

/** Parses a template, or returns where its syntax is broken. */
function parse(source: string, file: string): AST | PackIssue {
  try {
    return Handlebars.parse(source);
  } catch (error) {
    const { message, lineNumber, column } = error as {
      message: string;
      lineNumber?: number;
      column?: number;
    };
    const line =
      lineNumber ?? Number(/on line (\d+)/.exec(message)?.[1] ?? Number.NaN);
    return {
      code: 'template-syntax',
      file,
      ...(Number.isInteger(line) ? { line } : {}),
      ...(column === undefined ? {} : { column: column + 1 }),
      message: `Handlebars syntax error: ${message.split('\n')[0]}`,
    };
  }
}

/** Every construct outside the supported subset, with its location. */
function unsupported(program: AST, file: string): PackIssue[] {
  const issues: PackIssue[] = [];
  const report = (node: Node, message: string) =>
    issues.push({ code: 'template-unsupported', ...at(file, node), message });

  const expression = (node: Expression, statement: Node) => {
    if (node.type === 'SubExpression')
      call(node as hbs.AST.SubExpression, statement, false);
    if (node.type === 'PathExpression') {
      const path = node as Path;
      if (path.data && !dataVariables.has(path.parts[0] ?? '')) {
        report(statement, `@${path.parts[0]} is not a supported data variable`);
      }
    }
  };
  const call = (node: Call, statement: Node, block: boolean) => {
    if (node.path.type !== 'PathExpression') {
      report(statement, 'a literal cannot be used as a field or helper name');
      return;
    }
    const name = node.path.original;
    const helper = !isSimpleName(node.path)
      ? undefined
      : block
        ? blockHelpers.has(name)
          ? { params: 1, hash: [] }
          : undefined
        : Object.hasOwn(inlineHelpers, name)
          ? inlineHelpers[name]
          : undefined;
    const isCall = block || node.params.length > 0 || node.hash !== undefined;
    if (!helper) {
      if (isCall) report(statement, `{{${name}}} is not a supported helper`);
      else expression(node.path, statement);
      return;
    }
    if (node.params.length !== helper.params) {
      report(
        statement,
        `${name} takes ${helper.params} argument${helper.params === 1 ? '' : 's'}`,
      );
    }
    for (const pair of node.hash?.pairs ?? []) {
      if (!helper.hash.includes(pair.key)) {
        report(statement, `${name} does not accept ${pair.key}=`);
      }
      const choices = helper.choices?.[pair.key];
      if (
        choices &&
        !(
          pair.value.type === 'StringLiteral' &&
          choices.includes((pair.value as hbs.AST.StringLiteral).value)
        )
      ) {
        report(
          statement,
          `${name} ${pair.key}= must be one of ${choices.map(choice => `"${choice}"`).join(', ')}`,
        );
      }
      expression(pair.value, statement);
    }
    for (const param of node.params) expression(param, statement);
  };
  const visit = (program: AST | undefined) => {
    for (const statement of program?.body ?? []) visitStatement(statement);
  };
  const visitStatement = (statement: Statement) => {
    switch (statement.type) {
      case 'MustacheStatement': {
        const mustache = statement as hbs.AST.MustacheStatement;
        if (!mustache.escaped) {
          report(
            statement,
            'raw HTML ({{{…}}} or {{& …}}) is not allowed: every printed text must be checkable',
          );
        }
        call(mustache as Call, statement, false);
        return;
      }
      case 'BlockStatement': {
        const block = statement as hbs.AST.BlockStatement;
        call(block, statement, true);
        visit(block.program);
        visit(block.inverse);
        return;
      }
      case 'PartialStatement':
      case 'PartialBlockStatement':
        report(statement, 'partials are not supported: use one template file');
        return;
      case 'Decorator':
      case 'DecoratorBlock':
        report(statement, 'decorators and inline partials are not supported');
        return;
    }
  };
  visit(program);
  return issues;
}

/** One level of the context stack, as Handlebars' `depths`. */
type Frame = {
  context: unknown;
  data: Record<string, unknown>;
  blockParams: Map<string, unknown>[];
  parent: Frame | undefined;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Handlebars' notion of an empty value: falsy but 0, or an empty array. */
const isEmpty = (value: unknown) =>
  (!value && value !== 0) || (Array.isArray(value) && value.length === 0);

/** `if`/`unless` without includeZero: 0 counts as false too. */
const isFalsy = (value: unknown) => !value || isEmpty(value);

function groupThousands(value: number, decimals: number | undefined): string {
  const raw = decimals === undefined ? String(value) : value.toFixed(decimals);
  const [integer = '', fraction] = raw.split('.');
  return (
    integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',') +
    (fraction === undefined ? '' : `.${fraction}`)
  );
}

/**
 * The ROC (民國) year, month and day of a `YYYY-MM-DD` calendar date, read from
 * its digits alone: no Date, so neither the timezone nor the locale can shift
 * it. Undefined for anything else, and for dates before 民國元年 (1912).
 */
function rocParts(value: string): [number, number, number] | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [year, month, day] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1912 || day < 1 || day > (days[month - 1] ?? 0)) return undefined;
  return [year - 1911, month, day];
}

function render(ast: AST, root: unknown, file: string): string {
  const fail = (node: Node, code: string, message: string): never => {
    throw new TemplateError([{ code, ...at(file, node), message }]);
  };

  const property = (value: unknown, key: string, node: Node): unknown => {
    if (value === null || value === undefined) return null;
    // A string's own properties (length, indexes) resolve, as in Handlebars.
    const target: unknown = typeof value === 'string' ? Object(value) : value;
    if (!isObject(target) || !Object.hasOwn(target, key)) {
      const where =
        node.type === 'PathExpression'
          ? ` (in {{${(node as Path).original}}})`
          : '';
      fail(
        node,
        'template-unknown-field',
        `the data has no field "${key}"${where}`,
      );
    }
    return (target as Record<string, unknown>)[key];
  };

  const lookupPath = (path: Path, frame: Frame): unknown => {
    let parts = path.parts;
    let value: unknown;
    if (path.data) {
      const [name, ...rest] = parts;
      // `@../index`: each {{#each}} data frame keeps its parent, as in
      // Handlebars' createFrame.
      let data: Record<string, unknown> | undefined = frame.data;
      for (let i = 0; i < path.depth; i++) {
        data = data?._parent as Record<string, unknown> | undefined;
      }
      if (name === 'root') value = root;
      else value = data?.[name ?? ''];
      parts = rest;
    } else {
      const first = parts[0];
      const scope =
        path.depth === 0 && isSimpleHead(path) && first !== undefined
          ? frame.blockParams.find(params => params.has(first))
          : undefined;
      if (scope !== undefined && first !== undefined) {
        value = scope.get(first);
        parts = parts.slice(1);
      } else {
        let target: Frame | undefined = frame;
        for (let i = 0; i < path.depth; i++) target = target?.parent;
        value = target?.context;
      }
    }
    for (const part of parts) value = property(value, part, path);
    return value;
  };
  const isSimpleHead = (path: Path) => !/^\.|^this\b/.test(path.original);

  const evaluate = (
    node: Expression,
    frame: Frame,
    statement: Node,
  ): unknown => {
    switch (node.type) {
      case 'PathExpression':
        return lookupPath(node as Path, frame);
      case 'SubExpression':
        return callHelper(node as hbs.AST.SubExpression, frame, statement);
      case 'StringLiteral':
      case 'NumberLiteral':
      case 'BooleanLiteral':
        return (node as hbs.AST.StringLiteral).value;
      case 'NullLiteral':
        return null;
      default:
        return undefined;
    }
  };

  const callHelper = (node: Call, frame: Frame, statement: Node): unknown => {
    const name = node.path.original;
    const params = node.params.map(param => evaluate(param, frame, statement));
    const hash = Object.fromEntries(
      (node.hash?.pairs ?? []).map(pair => [
        pair.key,
        evaluate(pair.value, frame, statement),
      ]),
    );
    switch (name) {
      case 'eq':
        return params[0] === params[1];
      case 'lookup': {
        const [object, key] = params;
        if (object === null || object === undefined) return object;
        return property(object, String(key), statement);
      }
      case 'number': {
        const [value] = params;
        const { decimals } = hash;
        if (value === null || value === undefined) return '';
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          fail(
            statement,
            'template-render',
            `number needs a number, got ${kind(value)}`,
          );
        }
        if (
          decimals !== undefined &&
          !(
            Number.isInteger(decimals) &&
            Number(decimals) >= 0 &&
            Number(decimals) <= 20
          )
        ) {
          fail(
            statement,
            'template-render',
            'number decimals= must be an integer 0-20',
          );
        }
        return groupThousands(value as number, decimals as number | undefined);
      }
      case 'rocDate': {
        const [value] = params;
        if (value === null || value === undefined) return '';
        const parts = typeof value === 'string' ? rocParts(value) : undefined;
        if (parts === undefined) {
          fail(
            statement,
            'template-render',
            typeof value === 'string'
              ? `rocDate needs a YYYY-MM-DD date from 1912-01-01 on, got "${value}"`
              : `rocDate needs a YYYY-MM-DD string, got ${kind(value)}`,
          );
        }
        const format = rocFormats[String(hash.format ?? 'text')];
        return format?.(...(parts as [number, number, number])) ?? '';
      }
    }
    return fail(
      statement,
      'template-unsupported',
      `{{${name}}} is not a supported helper`,
    );
  };

  const kind = (value: unknown) =>
    Array.isArray(value)
      ? 'an array'
      : value === null
        ? 'null'
        : `a ${typeof value}`;

  const child = (
    frame: Frame,
    context: unknown,
    data: Record<string, unknown>,
    params: Map<string, unknown> | undefined,
  ): Frame => {
    const blockParams = params
      ? [params, ...frame.blockParams]
      : frame.blockParams;
    return context === frame.context
      ? { ...frame, data, blockParams }
      : { context, data, blockParams, parent: frame };
  };

  const program = (node: AST | undefined, frame: Frame): string =>
    (node?.body ?? []).map(statement => run(statement, frame)).join('');

  const names = (node: AST | undefined, ...values: unknown[]) => {
    const declared = node?.blockParams ?? [];
    return declared.length === 0
      ? undefined
      : new Map(declared.map((name, i) => [name, values[i]]));
  };

  const block = (node: hbs.AST.BlockStatement, frame: Frame): string => {
    const value = evaluate(node.params[0] as Expression, frame, node);
    switch (node.path.original) {
      case 'if':
        return program(isFalsy(value) ? node.inverse : node.program, frame);
      case 'unless':
        return program(isFalsy(value) ? node.program : node.inverse, frame);
      case 'with':
        return isEmpty(value)
          ? program(node.inverse, frame)
          : program(
              node.program,
              child(frame, value, frame.data, names(node.program, value)),
            );
      default: {
        if (value === null || value === undefined || value === false) {
          return program(node.inverse, frame);
        }
        if (!isObject(value)) {
          fail(
            node,
            'template-render',
            `each needs an array or object, got ${kind(value)}`,
          );
        }
        const entries: [string | number, unknown][] = Array.isArray(value)
          ? value.map((item, i) => [i, item])
          : Object.keys(value).map(key => [
              key,
              (value as Record<string, unknown>)[key],
            ]);
        if (entries.length === 0) return program(node.inverse, frame);
        return entries
          .map(([key, item], i) => {
            const data = {
              ...frame.data,
              _parent: frame.data,
              index: i,
              key,
              first: i === 0,
              last: i === entries.length - 1,
            };
            return program(
              node.program,
              child(frame, item, data, names(node.program, item, key)),
            );
          })
          .join('');
      }
    }
  };

  // Budgets, so that a pack can't make filling (or checking it) run away.
  let steps = 0;
  let size = 0;
  const output = (text: string, statement: Statement) => {
    size += text.length;
    if (size > maxOutput) {
      fail(
        statement,
        'template-render',
        `the filled template exceeds ${maxOutput} characters`,
      );
    }
    return text;
  };

  const run = (statement: Statement, frame: Frame): string => {
    if (++steps > maxSteps) {
      fail(
        statement,
        'template-render',
        `filling took more than ${maxSteps} steps: are {{#each}} blocks nested over the same data?`,
      );
    }
    switch (statement.type) {
      case 'ContentStatement':
        return output((statement as hbs.AST.ContentStatement).value, statement);
      case 'MustacheStatement': {
        const mustache = statement as hbs.AST.MustacheStatement;
        const path = mustache.path as Path;
        const isHelper =
          isSimpleName(path) && Object.hasOwn(inlineHelpers, path.original);
        const value = isHelper
          ? callHelper(mustache as Call, frame, statement)
          : lookupPath(path, frame);
        let text: string;
        try {
          text = Handlebars.Utils.escapeExpression(value as string);
        } catch {
          // e.g. an object whose toString field isn't a function.
          return fail(
            statement,
            'template-render',
            `{{${path.original}}} is not a value that can be printed`,
          );
        }
        return output(text, statement);
      }
      case 'BlockStatement':
        return block(statement as hbs.AST.BlockStatement, frame);
      default:
        return '';
    }
  };

  return program(ast, {
    context: root,
    data: {},
    blockParams: [],
    parent: undefined,
  });
}

/**
 * A parsed template and what is wrong with it: a syntax error (then no AST),
 * or the constructs outside the supported subset.
 */
export function parseTemplate(
  source: string,
  file: string,
): { ast?: AST; issues: PackIssue[] } {
  const ast = parse(source, file);
  if (!('body' in ast)) return { issues: [ast] };
  return { ast, issues: unsupported(ast, file) };
}

/** Renders a template that parseTemplate found no issue in. */
export function renderTemplate(ast: AST, data: unknown, file: string): string {
  return render(ast, data, file);
}

/**
 * Fills `data` into a Handlebars template. Lookups are strict: a field the
 * data lacks is an error, a field that is null prints blank. Throws
 * TemplateError, located in `file`, for anything outside the supported subset.
 */
export function fill(
  template: string,
  data: unknown,
  { file = 'template.hbs' }: { file?: string } = {},
): string {
  const { ast, issues } = parseTemplate(template, file);
  if (ast === undefined || issues.length > 0) throw new TemplateError(issues);
  return renderTemplate(ast, data, file);
}
