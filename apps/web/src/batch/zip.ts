// A finished batch as one zip, streamed from R2: batch.json, fixtures.json,
// then each completed fixture's files. Entries are stored (PDFs don't
// compress) with a fixed time, so the same batch always zips to the same
// bytes, and only one R2 object is in memory at a time.
import { Zip, ZipPassThrough } from 'fflate';
import { type FixtureFile, fixtureKey } from './fixture.ts';

export interface ZipEntry {
  name: string;
  /** The entry's bytes: given, or read from R2 when the stream gets to it. */
  bytes: Uint8Array | (() => Promise<ReadableStream<Uint8Array>>);
}

// fflate writes DOS times from local-time fields; any fixed instant works.
const entryTime = new Date(2000, 0, 1);

export function zipStream(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  let written = Promise.resolve();
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      void writer.abort(error);
      return;
    }
    written = written.then(() => writer.write(chunk));
    if (final) written = written.then(() => writer.close());
  });

  void (async () => {
    try {
      for (const entry of entries) {
        const file = new ZipPassThrough(entry.name);
        file.mtime = entryTime;
        zip.add(file);
        if (entry.bytes instanceof Uint8Array) {
          file.push(entry.bytes, true);
        } else {
          const reader = (await entry.bytes()).getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            file.push(value);
            // Wait for the consumer before reading more (backpressure).
            await written;
          }
          file.push(new Uint8Array(0), true);
        }
        await written;
      }
      zip.end();
      await written;
    } catch (error) {
      console.error('zip: streaming the batch failed', error);
      await writer.abort(error).catch(() => undefined);
    }
  })();
  return readable;
}

const files: FixtureFile[] = ['data.json', 'gt.json', 'fixture.pdf'];

/** The zip entries of one completed fixture, read from R2 lazily. */
export function fixtureEntries(
  bucket: R2Bucket,
  batchId: string,
  index: number,
): ZipEntry[] {
  return files.map(file => ({
    name: `${String(index).padStart(4, '0')}/${file}`,
    bytes: async () => {
      const key = fixtureKey(batchId, index, file);
      const object = await bucket.get(key);
      if (!object) throw new Error(`missing R2 object ${key}`);
      return object.body;
    },
  }));
}
