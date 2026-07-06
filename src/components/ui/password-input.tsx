import * as React from 'react';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import { cn } from '@/src/lib/utils';
import { Input } from './input';

/** Password input with a visibility toggle, mirroring Mantine's PasswordInput. */
const PasswordInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>
>(({ className, ...props }, ref) => {
  const [visible, setVisible] = React.useState(false);
  return (
    <div className="relative">
      <Input
        ref={ref}
        type={visible ? 'text' : 'password'}
        className={cn('pe-11', className)}
        {...props}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={visible ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 end-1 my-1 flex w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-card hover:text-foreground"
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? <IconEyeOff className="size-4" /> : <IconEye className="size-4" />}
      </button>
    </div>
  );
});
PasswordInput.displayName = 'PasswordInput';

export { PasswordInput };
