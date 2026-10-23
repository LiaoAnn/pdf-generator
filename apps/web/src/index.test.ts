import { expect, test } from 'vitest';
import worker from './index.ts';

test('placeholder Worker answers', async () => {
  const response = await worker.fetch();
  expect(await response.text()).toBe('pdf-generator web: placeholder');
});
