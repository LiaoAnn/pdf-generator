// Splits the platform fonts over Chrome's 6.25 MiB batch-cache limit
// (T07-37) into their unicode-range chunks in public/fonts/. The sources
// are the patched whole fonts this repo commits in apps/print/fonts/; the
// chunks are a gitignored build product wrangler's build command makes
// before `wrangler dev`, `wrangler deploy` and the tests, so they are
// never committed. Run by hand with `pnpm --filter @pdf-generator/print
// chunks`. Pure build output: the folders resolve from this file, never
// the working directory, the order is fixed, there is no time or
// randomness, and every chunk lands atomically (a same-folder temp file
// renamed over the target), so a reader never sees a half-written chunk
// if two builds overlap.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { splitFont } from './split.ts';

const fontsDir = join(import.meta.dirname, '../../fonts');
const outDir = join(import.meta.dirname, '../../public/fonts');

// The fonts build.ts marks `split`, in its source order (T07-37).
const fileNames = [
  'NotoSerifTC-Regular.otf',
  'NotoSerifTC-Bold.otf',
  'LXGWWenKaiTC-Regular.ttf',
];

await mkdir(outDir, { recursive: true });
for (const file of fileNames) {
  const font = new Uint8Array(await readFile(join(fontsDir, file)));
  for (const chunk of await splitFont(font, file)) {
    const target = join(outDir, chunk.file);
    // A same-folder (same-mount) temp file renamed over the target: no
    // reader ever sees half a chunk, even when two builds overlap. The
    // pid keeps their temp files apart so they cannot corrupt each other.
    const temp = join(outDir, `.${process.pid}-${chunk.file}.tmp`);
    await writeFile(temp, chunk.font);
    await rename(temp, target);
    console.log(`public/fonts/${chunk.file} (${chunk.font.length} bytes)`);
  }
}
