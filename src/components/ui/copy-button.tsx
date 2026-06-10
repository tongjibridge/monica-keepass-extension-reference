import * as React from 'react';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { Button, type ButtonProps } from './button';

/** Copies `value` to the clipboard and flashes a check mark for feedback. */
export function CopyIconButton({
  value,
  size = 'iconSm',
  variant = 'ghost',
  ...props
}: { value: string } & Omit<ButtonProps, 'onClick' | 'children'>) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  React.useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1200);
  };

  return (
    <Button size={size} variant={variant} aria-label="Copy" onClick={copy} {...props}>
      {copied ? <IconCheck className="size-4 text-emerald-600" /> : <IconCopy className="size-4" />}
    </Button>
  );
}
