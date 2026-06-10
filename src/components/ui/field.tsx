import * as React from 'react';
import { cn } from '@/src/lib/utils';
import { Label } from './label';

/**
 * Label + optional description wrapper around a form control, replacing
 * Mantine's built-in `label`/`description` input props.
 */
export function Field({
  label,
  description,
  className,
  children,
}: {
  label?: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      {label && <Label>{label}</Label>}
      {children}
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}
