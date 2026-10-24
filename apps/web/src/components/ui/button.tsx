import type * as React from 'react';

import { cn } from '@/lib/utils';

const variants = {
  default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
  outline:
    'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
};

/** The button look, also for links that act as buttons. */
export function buttonClass(
  variant: keyof typeof variants = 'default',
  className?: string,
) {
  return cn(
    'inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
    variants[variant],
    className,
  );
}

function Button({
  className,
  variant,
  ...props
}: React.ComponentProps<'button'> & { variant?: keyof typeof variants }) {
  return (
    <button
      data-slot="button"
      className={buttonClass(variant, className)}
      {...props}
    />
  );
}

export { Button };
