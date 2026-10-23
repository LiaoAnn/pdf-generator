import type { Rng } from '../random.ts';
import type { Gender } from './ids.ts';

// Common surnames, most frequent first, weighted roughly by population share.
const surnames = [
  ...'陳林黃張李王吳劉蔡楊',
  ...'許鄭謝洪郭邱曾廖賴徐',
  ...'周葉蘇莊呂江何蕭羅高',
  ...'潘簡朱鍾游彭詹胡施沈',
  ...'余盧梁趙顏柯翁魏孫戴',
];
const surnameWeights = surnames.map((_, i) => (i < 10 ? 8 : i < 20 ? 4 : 2));
const compoundSurnames = ['歐陽', '司馬', '諸葛', '張簡', '范姜'];

const givenCharacters = {
  male: [...'志明家豪俊傑建宏冠宇承翰柏翰宗翰文彥信宏哲維國強偉誠振德子軒'],
  female: [...'淑芬美玲雅婷怡君佳穎欣怡靜宜詩涵惠雯珮瑜筱萍秀琴宜蓁婉婷'],
};

/** Chinese full name: surname + 1-2 character given name. */
export function personName(rng: Rng, gender: Gender = 'any'): string {
  const surname =
    rng.int(1, 100) <= 2
      ? rng.pick(compoundSurnames)
      : rng.weighted(surnames, surnameWeights);
  const pool =
    givenCharacters[
      gender === 'any' ? rng.pick(['male', 'female'] as const) : gender
    ];
  // Compound surnames take a one-character given name more often, keeping
  // names at 2-4 characters.
  const length = rng.int(1, 10) <= (surname.length === 2 ? 5 : 1) ? 1 : 2;
  let given = '';
  for (let i = 0; i < length; i++) given += rng.pick(pool);
  return surname + given;
}
