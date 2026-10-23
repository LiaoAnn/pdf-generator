import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { navItems } from '@/nav';
import styles from '@/styles.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'PDF Fixtures' },
    ],
    links: [{ rel: 'stylesheet', href: styles }],
  }),
  component: RootLayout,
});

function RootLayout() {
  return (
    <RootDocument>
      <header className="border-b">
        <nav className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-3">
          <span className="font-semibold">PDF Fixtures</span>
          {navItems.map(item => (
            <Link
              key={item.to}
              to={item.to}
              className="text-muted-foreground text-sm hover:text-foreground"
              activeProps={{ className: 'text-foreground font-medium' }}>
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">
        <Outlet />
      </main>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hant-TW">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
