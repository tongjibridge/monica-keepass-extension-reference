import * as React from 'react';
import { cn } from '@/src/lib/utils';

function Separator({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      className={cn('h-px w-full shrink-0 bg-border', className)}
      {...props}
    />
  );
}

export { Separator };
