import * as React from 'react';
import { cn } from '@/src/lib/utils';

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-9 w-full min-w-0 rounded-lg border border-border bg-card px-3 py-1 text-sm shadow-sm transition-colors',
        'placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'file:me-2 file:h-full file:cursor-pointer file:rounded-md file:border-0 file:bg-secondary file:px-2 file:py-0.5 file:text-xs file:font-medium file:text-secondary-foreground',
        type === 'file' && 'cursor-pointer pt-1.5',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export { Input };
