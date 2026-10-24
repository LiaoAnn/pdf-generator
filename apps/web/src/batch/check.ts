import type { GroundTruth } from '@pdf-generator/contract';
import { checkPdf, type SelfCheckReport } from '@pdf-generator/self-check';

export type Checker = {
  /** `fonts`: PostScript names of the pack's own fonts, also allowed. */
  check(
    pdf: Uint8Array,
    gt: GroundTruth,
    fonts: readonly string[],
  ): Promise<SelfCheckReport>;
};

// PostScript names of the platform fonts, which every pack may use.
export const platformFonts: readonly string[] = [
  'LXGWWenKaiTC-Regular',
  'NotoSansSymbols2-Regular',
  'NotoSansTC-Bold',
  'NotoSansTC-Regular',
  'NotoSerifTC-Bold',
  'NotoSerifTC-Regular',
];

export const selfChecker: Checker = {
  check: (pdf, gt, fonts) =>
    checkPdf(pdf, gt, { fonts: [...platformFonts, ...fonts] }),
};
