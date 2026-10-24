// Rebuilds public/fonts from the upstream files T03 tested (sha256-checked),
// with the Noto CJK and LXGW WenKai cmaps patched (T03 §2.5; every code point
// gets its own glyph, T07-13) and the Noto CJK `locl` feature emptied
// (T07-11). Run with
// `pnpm --filter @pdf-generator/print fonts`; commit the result.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { disableLocl, patchCmap } from './sfnt.ts';

const noto = 'https://github.com/notofonts/noto-cjk/raw/main';
const sources = [
  {
    file: 'NotoSansTC-Regular.otf',
    url: `${noto}/Sans/SubsetOTF/TC/NotoSansTC-Regular.otf`,
    sha256: '5bab0cb3c1cf89dde07c4a95a4054b195afbcfe784d69d75c340780712237537',
    cmap: true,
    locl: true,
  },
  {
    file: 'NotoSansTC-Bold.otf',
    url: `${noto}/Sans/SubsetOTF/TC/NotoSansTC-Bold.otf`,
    sha256: '55420b259eb119bf5f2a0aadba10cf9d736c12d64ab93e78546d69ef5f43558b',
    cmap: true,
    locl: true,
  },
  {
    file: 'NotoSerifTC-Regular.otf',
    url: `${noto}/Serif/SubsetOTF/TC/NotoSerifTC-Regular.otf`,
    sha256: '63515eb0622d589a2f4062e8757c598b3da3bffd053f69abd181c210158ef10c',
    cmap: true,
    locl: true,
  },
  {
    file: 'NotoSerifTC-Bold.otf',
    url: `${noto}/Serif/SubsetOTF/TC/NotoSerifTC-Bold.otf`,
    sha256: '3ca2b3294ec84b795d0a45695e78e3612a44dce50f9fc776cd40206340a5768d',
    cmap: true,
    locl: true,
  },
  {
    file: 'LXGWWenKaiTC-Regular.ttf',
    url: 'https://github.com/lxgw/LxgwWenkaiTC/releases/download/v1.530/LXGWWenKaiTC-Regular.ttf',
    sha256: '6662480a3f95b4a90c80b189c679617a48adce3a505118a6af63ce5a482b83fa',
    cmap: true,
    locl: false,
  },
  {
    file: 'NotoSansSymbols2-Regular.ttf',
    url: 'https://github.com/google/fonts/raw/main/ofl/notosanssymbols2/NotoSansSymbols2-Regular.ttf',
    sha256: '7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21',
    cmap: false,
    locl: false,
  },
  {
    file: 'LICENSE-noto-cjk.txt',
    url: `${noto}/Sans/LICENSE`,
    sha256: '6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2',
    cmap: false,
    locl: false,
  },
  {
    file: 'LICENSE-lxgw.txt',
    url: 'https://github.com/lxgw/LxgwWenkaiTC/raw/main/OFL.txt',
    sha256: '1a13783bf4337242834b60309cdcdbeb566ae3f923576fdbba8b78db9d174def',
    cmap: false,
    locl: false,
  },
  {
    file: 'LICENSE-symbols2.txt',
    url: 'https://github.com/google/fonts/raw/main/ofl/notosanssymbols2/OFL.txt',
    sha256: 'b118dd41337806a5d4797052c77caf3bd096aed783e5eb21b4d11154351e1ac0',
    cmap: false,
    locl: false,
  },
];

const cache = join(import.meta.dirname, '../../node_modules/.cache/fonts');
const out = join(import.meta.dirname, '../../public/fonts');
const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

async function source(file: string, url: string): Promise<Uint8Array> {
  try {
    return await readFile(join(cache, file));
  } catch {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(join(cache, file), bytes);
    return bytes;
  }
}

await mkdir(cache, { recursive: true });
await mkdir(out, { recursive: true });
for (const { file, url, sha256: expected, cmap, locl } of sources) {
  const bytes = await source(file, url);
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new Error(`${file}: sha256 ${actual}, expected ${expected}`);
  }
  const patched = cmap ? patchCmap(bytes) : undefined;
  const emptied = locl ? disableLocl(patched?.font ?? bytes) : undefined;
  const font = emptied?.font ?? patched?.font ?? bytes;
  await writeFile(join(out, file), font);
  const notes = [
    patched &&
      `${patched.dropped.length} code points dropped, ${patched.copied.length} given their own glyph`,
    emptied && `${emptied.features} locl features emptied`,
  ].filter(Boolean);
  console.log(
    `public/fonts/${file} sha256 ${sha256(font)}` +
      (notes.length > 0 ? ` (${notes.join(', ')})` : ''),
  );
}
