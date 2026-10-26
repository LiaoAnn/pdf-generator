import { z } from 'zod';

/** The 22 official 縣市, in the order the Ministry of the Interior lists them. */
export const taiwanCities = [
  '臺北市',
  '新北市',
  '桃園市',
  '臺中市',
  '臺南市',
  '高雄市',
  '基隆市',
  '新竹市',
  '嘉義市',
  '新竹縣',
  '苗栗縣',
  '彰化縣',
  '南投縣',
  '雲林縣',
  '嘉義縣',
  '屏東縣',
  '宜蘭縣',
  '花蓮縣',
  '臺東縣',
  '澎湖縣',
  '金門縣',
  '連江縣',
] as const;

/** Whether a `YYYY-MM-DD` string names a day of the Gregorian calendar. */
function isCalendarDate(date: string): boolean {
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0);
}

const probability = z.number().min(0).max(1);
const gender = z.enum(['male', 'female', 'any']);
const isoDate = z
  .string()
  .regex(/^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])(?![\s\S])/)
  .refine(isCalendarDate, 'not a calendar date')
  .describe('YYYY-MM-DD');
const decimals = (max: number) => z.int().min(0).max(max);

const fieldPath = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*(?:\[\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\])?)*(?![\s\S])/,
  )
  .describe(
    "Path from the record root to a numeric field, '.'-separated; `[]` after an array field means each of its items, e.g. `transactions[].amount`, except on an array the field itself is inside: there it means the item the field is in (the current row), e.g. `rows[].price` from `rows[].subtotal`.",
  );

// Keys every field rule accepts.
const common = {
  description: z.string().optional(),
  blankProbability: probability
    .optional()
    .describe('Chance the value is null, printed blank.'),
};

type Range = { min: number | string; max: number | string };
const minNotAboveMax = (field: Range) => field.min <= field.max;
const atMin = { message: 'min must not exceed max', path: ['min'] };

type Common = { description?: string; blankProbability?: number };
type Scalar = string | number | boolean;
type Gender = 'male' | 'female' | 'any';

/** One field rule; `type` picks the generator, the generated value's shape is in each variant's description. */
export type RuleField = Common &
  (
    | { type: 'name' | 'nationalId'; gender?: Gender }
    | { type: 'businessId' | 'company' }
    | { type: 'address'; cities?: (typeof taiwanCities)[number][] }
    | { type: 'phone'; kind: 'mobile' | 'landline' }
    | { type: 'date'; min: string; max: string }
    | { type: 'money'; min: number; max: number; decimals?: number }
    | { type: 'integer'; min: number; max: number }
    | { type: 'number'; min: number; max: number; decimals: number }
    | { type: 'choice'; options: Scalar[]; weights?: number[] }
    | {
        type: 'text';
        lang: 'zh' | 'en' | 'mixed';
        minLength: number;
        maxLength: number;
        phrases?: string[];
      }
    | { type: 'checkbox'; probability?: number }
    | { type: 'constant'; value: Scalar }
    | { type: 'object'; fields: FieldMap }
    | {
        type: 'array';
        minItems: number;
        maxItems: number;
        items: RuleField;
        sortBy?: string;
      }
    | { type: 'sum'; of: string[] }
    | {
        type: 'runningBalance';
        opening: string;
        add: string[];
        subtract: string[];
      }
    | { type: 'percentage'; part: string; whole: string; decimals: number }
  );
type FieldMap = Record<string, RuleField>;

const fieldKey = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}(?![\s\S])/)
  .describe('Field key: up to 64 characters.');

const fieldMap = (): z.ZodType<FieldMap> =>
  z
    .record(fieldKey, ruleFieldSchema)
    .refine(map => Object.keys(map).length > 0, 'needs at least one field')
    .meta({
      description:
        'Field rules by key; keys are usable as Handlebars identifiers.',
      minProperties: 1,
    });

const sortByMessage = 'sortBy must name a date field of the items';

/** Whether an array's `sortBy` is absent or names a date field of its object items. */
function sortsByDate({
  items,
  sortBy,
}: {
  items: RuleField;
  sortBy?: string | undefined;
}): boolean {
  return (
    sortBy === undefined ||
    (items.type === 'object' &&
      Object.hasOwn(items.fields, sortBy) &&
      items.fields[sortBy]?.type === 'date')
  );
}

const ruleFieldSchema: z.ZodType<RuleField> = z
  .discriminatedUnion('type', [
    z
      .strictObject({
        ...common,
        type: z.literal('name'),
        gender: gender.optional(),
      })
      .describe('Chinese full name (string).'),
    z
      .strictObject({
        ...common,
        type: z.literal('nationalId'),
        gender: gender.optional(),
      })
      .describe('身分證字號 with a valid check digit (string).'),
    z
      .strictObject({ ...common, type: z.literal('businessId') })
      .describe('統一編號 with a valid check digit (string).'),
    z
      .strictObject({
        ...common,
        type: z.literal('address'),
        cities: z.array(z.enum(taiwanCities)).min(1).optional(),
      })
      .describe('Taiwanese postal address (string), in one of `cities`.'),
    z
      .strictObject({
        ...common,
        type: z.literal('phone'),
        kind: z.enum(['mobile', 'landline']),
      })
      .describe('Taiwanese phone number (string).'),
    z
      .strictObject({ ...common, type: z.literal('company') })
      .describe('Company name (string).'),
    z
      .strictObject({
        ...common,
        type: z.literal('date'),
        min: isoDate,
        max: isoDate,
      })
      .refine(minNotAboveMax, atMin)
      .describe('Date between min and max inclusive (string, YYYY-MM-DD).'),
    z
      .strictObject({
        ...common,
        type: z.literal('money'),
        min: z.number(),
        max: z.number(),
        decimals: decimals(2).optional(),
      })
      .refine(minNotAboveMax, atMin)
      .describe('Amount in TWD (number).'),
    z
      .strictObject({
        ...common,
        type: z.literal('integer'),
        min: z.int(),
        max: z.int(),
      })
      .refine(minNotAboveMax, atMin)
      .describe('Integer between min and max inclusive.'),
    z
      .strictObject({
        ...common,
        type: z.literal('number'),
        min: z.number(),
        max: z.number(),
        decimals: decimals(6),
      })
      .refine(minNotAboveMax, atMin)
      .describe('Number between min and max, rounded to `decimals`.'),
    z
      .strictObject({
        ...common,
        type: z.literal('choice'),
        options: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1),
        weights: z.array(z.number().min(0)).optional(),
      })
      .refine(
        ({ options, weights }) =>
          weights === undefined ||
          (weights.length === options.length &&
            weights.reduce((sum, weight) => sum + weight, 0) > 0),
        {
          message: 'weights needs one entry per option and a positive sum',
          path: ['weights'],
        },
      )
      .describe('One of `options`, picked by `weights` (uniform without).'),
    z
      .strictObject({
        ...common,
        type: z.literal('text'),
        lang: z.enum(['zh', 'en', 'mixed']),
        minLength: z.int().min(1),
        maxLength: z.int(),
        phrases: z
          .array(z.string().min(1).max(200).regex(/\S/))
          .min(1)
          .max(1000)
          .optional()
          .describe(
            'Phrases the text is built from instead of the built-in business wording, joined with the punctuation of `lang`; a phrase longer than what is left is cut.',
          ),
      })
      .refine(field => field.minLength <= field.maxLength, {
        message: 'minLength must not exceed maxLength',
        path: ['minLength'],
      })
      .describe('Filler text (string), length in characters.'),
    z
      .strictObject({
        ...common,
        type: z.literal('checkbox'),
        probability: probability.optional().describe('Chance it is checked.'),
      })
      .describe('Checkbox state (boolean).'),
    z
      .strictObject({
        ...common,
        type: z.literal('constant'),
        value: z.union([z.string(), z.number(), z.boolean()]),
      })
      .describe('Always `value`.'),
    z
      .strictObject({
        ...common,
        type: z.literal('object'),
        get fields(): z.ZodType<FieldMap> {
          return fieldMap();
        },
      })
      .describe('Nested object.'),
    z
      .strictObject({
        ...common,
        type: z.literal('array'),
        minItems: z.int().min(0),
        maxItems: z.int(),
        get items(): z.ZodType<RuleField> {
          return ruleFieldSchema;
        },
        sortBy: z
          .string({ error: sortByMessage })
          .optional()
          .describe(
            'Key of a date field of the items: items come out in ascending date order (stable), blank dates last.',
          ),
      })
      .refine(field => field.minItems <= field.maxItems, {
        message: 'minItems must not exceed maxItems',
        path: ['minItems'],
      })
      .refine(sortsByDate, { message: sortByMessage, path: ['sortBy'] })
      .describe('Array of minItems to maxItems values, e.g. table rows.'),
    z
      .strictObject({
        ...common,
        type: z.literal('sum'),
        of: z.array(fieldPath).min(1),
      })
      .describe(
        'Sum of the referenced values (number); a path through an array adds every item, or only the current row for an array the field is inside; null counts as 0.',
      ),
    z
      .strictObject({
        ...common,
        type: z.literal('runningBalance'),
        opening: fieldPath,
        add: z.array(fieldPath),
        subtract: z.array(fieldPath),
      })
      .describe(
        'Inside an array item: row i = opening + Σ add − Σ subtract over rows 0..i (number).',
      ),
    z
      .strictObject({
        ...common,
        type: z.literal('percentage'),
        part: fieldPath,
        whole: fieldPath,
        decimals: decimals(6),
      })
      .describe(
        'part / whole × 100, rounded to `decimals` (number); a path through an array the field is inside reads the current row.',
      ),
  ])
  .meta({ id: 'RuleField' });

const numericTypes = new Set<RuleField['type']>([
  'money',
  'integer',
  'number',
  'sum',
  'runningBalance',
  'percentage',
]);

/** Whether `path` names a numeric field of `root`, per `fieldPath`'s rules. */
function resolvesToNumber(root: FieldMap, path: string): boolean {
  let map: FieldMap | undefined = root;
  let field: RuleField | undefined;
  for (const segment of path.split('.')) {
    if (map === undefined) return false;
    const each = segment.endsWith('[]');
    field = map[each ? segment.slice(0, -2) : segment];
    if (field === undefined || (field.type === 'array') !== each) return false;
    if (field.type === 'array') field = field.items;
    map = field.type === 'object' ? field.fields : undefined;
  }
  return (
    field !== undefined &&
    (numericTypes.has(field.type) ||
      (field.type === 'constant' && typeof field.value === 'number'))
  );
}

function pathsOf(field: RuleField): [string, (string | number)[]][] {
  switch (field.type) {
    case 'sum':
      return field.of.map((path, i) => [path, ['of', i]]);
    case 'runningBalance':
      return [
        [field.opening, ['opening']],
        ...field.add.map((path, i): [string, (string | number)[]] => [
          path,
          ['add', i],
        ]),
        ...field.subtract.map((path, i): [string, (string | number)[]] => [
          path,
          ['subtract', i],
        ]),
      ];
    case 'percentage':
      return [
        [field.part, ['part']],
        [field.whole, ['whole']],
      ];
    default:
      return [];
  }
}

/** How large a rule file and the records it generates may be, so a small rule file cannot exhaust a Worker. */
export const ruleLimits = {
  /** How deep fields may nest; a root field is level 1. */
  maxLevels: 32,
  /** The most values one record may hold. */
  maxValues: 100_000,
  /** The most characters of text one record may hold. */
  maxTextCharacters: 1_000_000,
} as const;

/**
 * The first field nested deeper than `ruleLimits.maxLevels` in an unparsed
 * rule file, found without recursion: zod's own descent through such a file
 * overflows the stack.
 */
function tooDeep(
  input: unknown,
): { path: (string | number)[]; level: number } | undefined {
  type Node = { value: unknown; path: (string | number)[]; level: number };
  const children = (
    fields: unknown,
    path: (string | number)[],
    level: number,
  ): Node[] =>
    typeof fields === 'object' && fields !== null
      ? Object.entries(fields).map(([key, value]) => ({
          value,
          path: [...path, 'fields', key],
          level,
        }))
      : [];
  const stack = children(
    typeof input === 'object' && input !== null
      ? (input as { fields?: unknown }).fields
      : undefined,
    [],
    1,
  ).reverse();
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (typeof node.value !== 'object' || node.value === null) continue;
    if (node.level > ruleLimits.maxLevels) return node;
    const { fields, items } = node.value as {
      fields?: unknown;
      items?: unknown;
    };
    if (items !== undefined) {
      stack.push({
        value: items,
        path: [...node.path, 'items'],
        level: node.level + 1,
      });
    }
    // One at a time: spreading a wide object exceeds the argument limit.
    for (const child of children(fields, node.path, node.level + 1).reverse()) {
      stack.push(child);
    }
  }
  return undefined;
}

/**
 * How many of something `field` generates at most: arrays multiply, objects
 * add. An array counts at least `perArray`: counting values, an empty array
 * is one.
 */
function worstCase(
  field: RuleField,
  leaf: (field: RuleField) => number,
  perArray = 0,
): number {
  switch (field.type) {
    case 'object':
      return Object.values(field.fields).reduce(
        (sum, child) => sum + worstCase(child, leaf, perArray),
        0,
      );
    case 'array':
      return Math.max(
        perArray,
        field.maxItems === 0
          ? 0
          : field.maxItems * worstCase(field.items, leaf, perArray),
      );
    default:
      return leaf(field);
  }
}

/** The most characters of text `field` holds; names, ids and the like are short and counted as values. */
function longestText(field: RuleField): number {
  switch (field.type) {
    case 'text':
      return field.maxLength;
    case 'constant':
      return typeof field.value === 'string' ? field.value.length : 0;
    case 'choice':
      return field.options.reduce<number>(
        (longest, option) =>
          typeof option === 'string'
            ? Math.max(longest, option.length)
            : longest,
        0,
      );
    default:
      return 0;
  }
}

/** `rules.json` in a template pack: how the fake-data engine builds a record. */
export const rulesSchema = z
  .unknown()
  .superRefine((input, ctx) => {
    const deep = tooDeep(input);
    if (deep !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `fields nest ${deep.level} levels deep; the limit is ${ruleLimits.maxLevels}`,
        path: deep.path,
      });
    }
  })
  .pipe(z.strictObject({ schemaVersion: z.literal(1), fields: fieldMap() }))
  .superRefine((rules, ctx) => {
    const visit = (field: RuleField, at: (string | number)[]) => {
      for (const [path, key] of pathsOf(field)) {
        if (!resolvesToNumber(rules.fields, path)) {
          ctx.addIssue({
            code: 'custom',
            message: `${path} does not name a numeric field`,
            path: [...at, ...key],
          });
        }
      }
      if (field.type === 'object') {
        for (const [key, child] of Object.entries(field.fields)) {
          visit(child, [...at, 'fields', key]);
        }
      }
      if (field.type === 'array') visit(field.items, [...at, 'items']);
    };
    for (const [key, field] of Object.entries(rules.fields)) {
      visit(field, ['fields', key]);
    }
    const record: RuleField = { type: 'object', fields: rules.fields };
    const values = worstCase(record, () => 1, 1);
    if (values > ruleLimits.maxValues) {
      ctx.addIssue({
        code: 'custom',
        message: `a record would hold up to ${values} values; the limit is ${ruleLimits.maxValues}`,
        path: ['fields'],
      });
    }
    const characters = worstCase(record, longestText);
    if (characters > ruleLimits.maxTextCharacters) {
      ctx.addIssue({
        code: 'custom',
        message: `a record would hold up to ${characters} characters of text; the limit is ${ruleLimits.maxTextCharacters}`,
        path: ['fields'],
      });
    }
  })
  .meta({
    title: 'Fake-data rule file',
    description: `rules.json in a template pack. Not expressible in JSON Schema: date min and max are days of the Gregorian calendar (no 2026-02-31); min ≤ max (date, money, integer, number), minLength ≤ maxLength, minItems ≤ maxItems; choice weights have one entry per option and a positive sum; every field path resolves, from the record root, to a numeric field (money, integer, number, sum, runningBalance, percentage, or a numeric constant), with \`[]\` exactly on array fields; \`[]\` on an array the field itself is inside means the current row; sortBy on an array names a date field of its object items; fields nest at most ${ruleLimits.maxLevels} levels (a root field is level 1, an object's fields and an array's items one level deeper); counting the most each array can hold (maxItems × its items; an empty array is one value), a record holds at most ${ruleLimits.maxValues} values and ${ruleLimits.maxTextCharacters} characters of text (counting text maxLength, string constants and the longest string choice option).`,
  });

export type Rules = z.infer<typeof rulesSchema>;
