import * as React from 'react';
import { cn } from '@/src/lib/utils';

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-11 w-full min-w-0 rounded-[24px] border border-transparent bg-secondary/80 px-4 py-1 text-sm transition-colors',
        'placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:border-ring focus-visible:bg-card focus-visible:ring-2 focus-visible:ring-ring/60',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'file:me-2 file:h-8 file:cursor-pointer file:rounded-full file:border-0 file:bg-card file:px-3 file:py-0.5 file:text-xs file:font-medium file:text-secondary-foreground',
        type === 'file' && 'cursor-pointer py-1.5',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export { Input };
