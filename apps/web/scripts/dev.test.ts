import { expect, test } from 'vitest';
import { viteDevArgs } from './dev.ts';

test.each([
  {
    form: '--ip <addr>',
    args: ['--port', '8787', '--ip', '0.0.0.0', '--strictPort'],
    expected: ['--port', '8787', '--host', '0.0.0.0', '--strictPort'],
  },
  {
    form: '--ip=<addr>',
    args: [
      '--host',
      '127.0.0.1',
      '--ip=0.0.0.0',
      '--port',
      '8787',
      '--strictPort',
    ],
    expected: [
      '--host',
      '127.0.0.1',
      '--host',
      '0.0.0.0',
      '--port',
      '8787',
      '--strictPort',
    ],
  },
])(
  'translates $form for Vite without dropping or reordering other dev arguments',
  ({ args, expected }) => {
    expect(viteDevArgs(args)).toEqual(expected);
  },
);
