import { expect, test } from 'vitest';
import worker from './index.ts';

test('placeholder Worker answers', async () => {
  const response = await worker.fetch(
    new Request('http://example.com/'),
    {} as Env,
    {} as ExecutionContext,
  );
  expect(await response.text()).toBe('pdf-generator web: placeholder');
});
