// The type of collect.js for callers, so their programs need no DOM lib.
import type { Measurement } from './measurement.ts';

/** Measures the paginated page; runs in the browser only (see collect.js). */
export declare function collect(): Measurement;
