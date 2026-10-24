import type { GroundTruth } from '@pdf-generator/contract';
import { checkPdf, type SelfCheckReport } from '@pdf-generator/self-check';

export type Checker = {
  check(pdf: Uint8Array, gt: GroundTruth): Promise<SelfCheckReport>;
};

// PostScript names of the platform fonts; pack-owned fonts come after T07-3.
export const platformFonts: readonly string[] = [
  'LXGWWenKaiTC-Regular',
  'NotoSansSymbols2-Regular',
  'NotoSansTC-Bold',
  'NotoSansTC-Regular',
  'NotoSerifTC-Bold',
  'NotoSerifTC-Regular',
];

export const selfChecker: Checker = {
  check: (pdf, gt) => checkPdf(pdf, gt, { fonts: platformFonts }),
};
