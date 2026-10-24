// The site's top navigation. A feature ticket that adds a page adds its entry
// here (for example T20: batch results).
export interface NavItem {
  to: string;
  label: string;
}

export const navItems: readonly NavItem[] = [
  { to: '/', label: '首頁' },
  { to: '/templates', label: '樣板' },
  { to: '/batches', label: '批次' },
];
