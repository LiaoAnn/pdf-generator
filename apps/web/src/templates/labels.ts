// Small display helpers the template pages share.

export function orientationLabel(orientation: 'portrait' | 'landscape') {
  return orientation === 'portrait' ? '直向' : '橫向';
}

/** A contract timestamp in Taiwan time, e.g. 2026/10/24 08:43. */
export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    dateStyle: 'medium',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(new Date(iso));
}
