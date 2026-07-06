import * as React from 'react';
import { cn } from '@/src/lib/utils';

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('rounded-2xl border border-border bg-card p-3 shadow-none', className)}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

export { Card };
