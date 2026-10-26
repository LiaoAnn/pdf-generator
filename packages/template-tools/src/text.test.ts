import { describe, expect, it } from 'vitest';
import { jsonPosition } from './text.ts';

describe('jsonPosition', () => {
  it('omits line and column when deeply nested JSON overflows location parsing', () => {
    const text = `${'['.repeat(200_000)}0${']'.repeat(200_000)}`;
    let result: ReturnType<typeof jsonPosition> | undefined;
    expect(() => {
      result = jsonPosition(text, [0]);
    }).not.toThrow();
    expect(result).toBeTypeOf('object');
    expect(result).not.toHaveProperty('line');
    expect(result).not.toHaveProperty('column');
  });

  it('locates a normal nested path by line and column', () => {
    expect(
      jsonPosition('{\n  "fields": {\n    "name": "value"\n  }\n}', [
        'fields',
        'name',
      ]),
    ).toEqual({ line: 3, column: 13 });
  });
});
