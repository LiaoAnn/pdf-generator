// Which table row numbers (001-045) appear in the PDF text of a /run JSON.
import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
for (const file of process.argv.slice(2)) {
  const run = JSON.parse(readFileSync(file, 'utf8'));
  const doc = await pdfjs.getDocument({ data: new Uint8Array(Buffer.from(run.pdfBase64, 'base64')) }).promise;
  const seen = new Set();
  for (let p = 1; p <= doc.numPages; p++) {
    // pdfjs may split "023" into "0" + "23": join items that share a baseline first.
    const lines = new Map();
    for (const it of (await (await doc.getPage(p)).getTextContent()).items) {
      const y = it.transform[5].toFixed(1);
      lines.set(y, (lines.get(y) ?? '') + it.str);
    }
    for (const line of lines.values()) {
      const m = /^(0[0-4]\d)\D/.exec(line);
      if (m) seen.add(m[1]);
    }
  }
  const missing = [...Array(45)].map((_, i) => String(i + 1).padStart(3, '0')).filter((k) => !seen.has(k));
  console.log(file, 'pages', doc.numPages, 'rows found', seen.size, 'missing', missing.join(',') || '-');
}
