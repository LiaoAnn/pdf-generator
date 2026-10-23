import type { taiwanCities } from '@pdf-generator/contract';
import type { Rng } from '../random.ts';

type TaiwanCity = (typeof taiwanCities)[number];

// 3-digit postal codes of the main 鄉鎮市區 of each 縣市, from Chunghwa Post.
const districtTable: Record<TaiwanCity, string> = {
  臺北市:
    '中正區100 大同區103 中山區104 松山區105 大安區106 萬華區108 信義區110 士林區111 北投區112 內湖區114 南港區115 文山區116',
  新北市:
    '板橋區220 汐止區221 新店區231 永和區234 中和區235 土城區236 三峽區237 樹林區238 鶯歌區239 三重區241 新莊區242 林口區244 蘆洲區247 淡水區251',
  桃園市:
    '中壢區320 平鎮區324 龍潭區325 楊梅區326 桃園區330 龜山區333 八德區334 大溪區335 大園區337 蘆竹區338',
  臺中市:
    '中區400 東區401 南區402 西區403 北區404 北屯區406 西屯區407 南屯區408 太平區411 大里區412 豐原區420 沙鹿區433',
  臺南市:
    '中西區700 東區701 南區702 北區704 安平區708 安南區709 永康區710 仁德區717 新營區730 善化區741',
  高雄市:
    '新興區800 前金區801 苓雅區802 鹽埕區803 鼓山區804 前鎮區806 三民區807 楠梓區811 小港區812 左營區813 岡山區820 鳳山區830',
  基隆市:
    '仁愛區200 信義區201 中正區202 中山區203 安樂區204 暖暖區205 七堵區206',
  新竹市: '東區300 北區300 香山區300',
  嘉義市: '東區600 西區600',
  新竹縣: '竹北市302 湖口鄉303 新豐鄉304 新埔鎮305 關西鎮306 竹東鎮310',
  苗栗縣: '竹南鎮350 頭份市351 後龍鎮356 通霄鎮357 苑裡鎮358 苗栗市360',
  彰化縣:
    '彰化市500 鹿港鎮505 和美鎮508 員林市510 溪湖鎮514 田中鎮520 北斗鎮521',
  南投縣: '南投市540 草屯鎮542 埔里鎮545 竹山鎮557',
  雲林縣: '斗南鎮630 虎尾鎮632 斗六市640 西螺鎮648 北港鎮651',
  嘉義縣: '民雄鄉621 太保市612 朴子市613 大林鎮622 布袋鎮625',
  屏東縣: '屏東市900 潮州鎮920 東港鎮928 恆春鎮946',
  宜蘭縣: '宜蘭市260 頭城鎮261 礁溪鄉262 羅東鎮265 蘇澳鎮270',
  花蓮縣: '花蓮市970 吉安鄉973 鳳林鎮975 玉里鎮981',
  臺東縣: '臺東市950 關山鎮956 成功鎮961',
  澎湖縣: '馬公市880 湖西鄉885',
  金門縣: '金沙鎮890 金湖鎮891 金寧鄉892 金城鎮893',
  連江縣: '南竿鄉209 北竿鄉210 莒光鄉211 東引鄉212',
};

type District = { name: string; postalCode: string };
const districts = new Map<TaiwanCity, District[]>(
  (Object.entries(districtTable) as [TaiwanCity, string][]).map(
    ([city, list]) => [
      city,
      list.split(' ').map(entry => ({
        name: entry.slice(0, -3),
        postalCode: entry.slice(-3),
      })),
    ],
  ),
);
const allCities = [...districts.keys()];

const roads = [
  ...['中山路', '中正路', '民生路', '民權路', '民族路', '建國路', '復興路'],
  ...['和平路', '自由路', '成功路', '光復路', '忠孝路', '仁愛路', '信義路'],
  ...['中華路', '博愛路', '文化路', '大同路', '林森路', '中興路', '永福街'],
  ...['公園路', '新生路', '長春路', '大仁街', '光明街', '福德街', '仁和街'],
];
const sections = [...'一二三四五'];

/** Postal address, e.g. `106臺北市大安區復興南路一段123巷4弄5號3樓`. */
export function address(rng: Rng, cities?: readonly TaiwanCity[]): string {
  const city = rng.pick(cities ?? allCities);
  const district = rng.pick(districts.get(city) as District[]);
  let tail = rng.pick(roads);
  if (tail.endsWith('路') && rng.int(1, 3) === 1) {
    tail += `${rng.pick(sections)}段`;
  }
  if (rng.int(1, 3) === 1) {
    tail += `${rng.int(1, 300)}巷`;
    if (rng.int(1, 3) === 1) tail += `${rng.int(1, 30)}弄`;
  }
  tail += `${rng.int(1, 400)}號`;
  if (rng.int(1, 2) === 1) tail += `${rng.int(1, 20)}樓`;
  return `${district.postalCode}${city}${district.name}${tail}`;
}

// Road (CJK), optional 段 in Chinese numerals inside it, then 巷, 弄, 號, 樓.
const tailPattern =
  /^\p{Script=Han}+[1-9][0-9]*(?:巷[1-9][0-9]*(?:弄[1-9][0-9]*)?)?號(?:[1-9][0-9]*樓)?$/u;

/** Whether `value` is an address whose postal code, 縣市 and 鄉鎮市區 agree, in `cities` if given. */
export function isValidAddress(
  value: string,
  cities?: readonly TaiwanCity[],
): boolean {
  const postalCode = value.slice(0, 3);
  if (!/^[0-9]{3}$/.test(postalCode)) return false;
  const rest = value.slice(3);
  return (cities ?? allCities).some(city =>
    (districts.get(city) ?? []).some(district => {
      const prefix = city + district.name;
      return (
        district.postalCode === postalCode &&
        rest.startsWith(prefix) &&
        tailPattern.test(rest.slice(prefix.length))
      );
    }),
  );
}
