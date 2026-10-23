import type { Rng } from '../random.ts';

const brands = [
  ...['宏達', '鴻海', '聯成', '台塑', '永豐', '華新', '大同', '統一'],
  ...['正新', '興隆', '金鼎', '昌達', '冠德', '瑞昱', '中興', '富邦'],
  ...['長榮', '光寶', '建大', '新光', '國泰', '佳和', '益立', '振豐'],
];
const industries = [
  ...['精密工業', '電子', '科技', '貿易', '建設', '食品', '紡織', '生技'],
  ...['光電', '物流', '機械', '塑膠', '印刷', '營造', '資訊', '化學工業'],
];
const forms = ['股份有限公司', '有限公司'];
const formWeights = [3, 2];

/** Company name ending in 股份有限公司 or 有限公司. */
export function companyName(rng: Rng): string {
  return (
    rng.pick(brands) + rng.pick(industries) + rng.weighted(forms, formWeights)
  );
}
