import { taiwanCities } from '@pdf-generator/contract';
import { beforeEach, expect, test } from 'vitest';
import { createRng } from '../random.ts';

let addresses: typeof import('./address.ts');
beforeEach(async () => {
  addresses = await import('./address.ts');
});

const known = [
  '100臺北市中正區',
  '106臺北市大安區',
  '110臺北市信義區',
  '220新北市板橋區',
  '330桃園市桃園區',
  '320桃園市中壢區',
  '407臺中市西屯區',
  '700臺南市中西區',
  '800高雄市新興區',
  '300新竹市東區',
  '302新竹縣竹北市',
  '200基隆市仁愛區',
  '500彰化縣彰化市',
  '540南投縣南投市',
  '640雲林縣斗六市',
  '600嘉義市東區',
  '612嘉義縣太保市',
  '900屏東縣屏東市',
  '260宜蘭縣宜蘭市',
  '970花蓮縣花蓮市',
  '950臺東縣臺東市',
  '880澎湖縣馬公市',
  '890金門縣金沙鎮',
  '209連江縣南竿鄉',
  '360苗栗縣苗栗市',
];

test('address draws cover all cities and independently agree with known district postcodes', () => {
  const rng = createRng('address-coverage', 'address');
  const seen = new Set<string>();
  for (let i = 0; i < 10_000; i++) {
    const value: string = addresses.address(rng);
    const city = taiwanCities.find(city => value.slice(3).startsWith(city));
    expect(city, value).toBeDefined();
    if (city) seen.add(city);
    expect(addresses.isValidAddress(value), value).toBe(true);
    expect(value).toMatch(
      /^[0-9]{3}\p{Script=Han}+[0-9]+(?:巷[0-9]+)?(?:弄[0-9]+)?號(?:[0-9]+樓)?$/u,
    );
    for (const prefix of known) {
      if (value.slice(3).startsWith(prefix.slice(3)))
        expect(value.slice(0, prefix.length), value).toBe(prefix);
    }
  }
  expect(seen).toEqual(new Set(taiwanCities));
});

test('validator accepts real district pairs and optional address components', () => {
  for (const prefix of known)
    for (const tail of ['中山路1號', '復興南路一段123巷4弄5號3樓'])
      expect(addresses.isValidAddress(prefix + tail), prefix + tail).toBe(true);
});

test('validator rejects mismatched geography and malformed road or house tails', () => {
  for (const value of [
    '100臺北市大安區中山路1號',
    '106新北市板橋區中山路1號',
    '999臺北市大安區中山路1號',
    '106臺北市不存在區中山路1號',
    '106臺北市大安區',
    '106臺北市大安區中山路號',
    '106臺北市大安區中山路一號',
    '106臺北市大安區中山路1號三樓',
    '106臺北市大安區中山路1段2號',
    '106臺北市大安區中山路1號\n',
    ' 106臺北市大安區中山路1號',
    '１０６臺北市大安區中山路1號',
  ])
    expect(addresses.isValidAddress(value), value).toBe(false);
});

test('city restrictions constrain generation and validation including outlying islands', () => {
  for (const cities of [['臺北市', '金門縣'], ['連江縣']] as const) {
    const rng = createRng('restricted', cities.join());
    const seen = new Set<string>();
    for (let i = 0; i < 1_000; i++) {
      const value: string = addresses.address(rng, cities);
      const city = cities.find(city => value.slice(3).startsWith(city));
      expect(city, value).toBeDefined();
      if (city) seen.add(city);
      expect(addresses.isValidAddress(value, cities)).toBe(true);
    }
    expect(seen).toEqual(new Set(cities));
  }
  expect(addresses.isValidAddress('106臺北市大安區中山路1號', ['金門縣'])).toBe(
    false,
  );
});
