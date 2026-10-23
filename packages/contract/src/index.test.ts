import { expect, test } from 'vitest';
import { packageName } from './index.ts';

test('package skeleton is wired into the workspace', () => {
  expect(packageName).toBe('@pdf-generator/contract');
});
