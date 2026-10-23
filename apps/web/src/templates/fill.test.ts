import { expect, test } from 'vitest';
import { fill } from './fill.ts';

test('fills spaced dot paths and escapes generated text rather than injecting markup', () => {
  const html = fill('<p>{{ contact.name }} / {{count}} / {{enabled}}</p>', {
    contact: { name: '<b>&"\'' },
    count: 0,
    enabled: false,
  });
  expect(html).toMatch(
    /^<p>&lt;b&gt;&amp;&quot;(?:&#39;|&#x27;|&apos;) \/ 0 \/ false<\/p>$/,
  );
});

test('rejects a missing path instead of silently printing an incomplete fixture', () => {
  expect(() =>
    fill('<p>{{contact.missing}}</p>', { contact: { name: '王小明' } }),
  ).toThrow();
});
