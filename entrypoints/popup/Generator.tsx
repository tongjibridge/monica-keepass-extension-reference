import { useCallback, useEffect, useState } from 'react';
import { IconCheck, IconCopy, IconRefresh } from '@tabler/icons-react';
import { Button } from '@/src/components/ui/button';
import { CheckboxField } from '@/src/components/ui/checkbox';
import { Progress } from '@/src/components/ui/progress';
import { Slider } from '@/src/components/ui/slider';
import {
  DEFAULT_PASSWORD_OPTIONS,
  estimateEntropyBits,
  generatePassword,
  strengthFromEntropy,
  type PasswordOptions,
} from '@/src/crypto/generator';

const STRENGTH_BAR: Record<string, string> = {
  weak: 'bg-red-500',
  fair: 'bg-amber-500',
  good: 'bg-lime-500',
  strong: 'bg-emerald-500',
};
const STRENGTH_VALUE: Record<string, number> = { weak: 25, fair: 50, good: 75, strong: 100 };

export function Generator({ onUse }: { onUse?: (password: string) => void }) {
  const [opts, setOpts] = useState<PasswordOptions>(DEFAULT_PASSWORD_OPTIONS);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const regenerate = useCallback(() => {
    try {
      setValue(generatePassword(opts));
      setError('');
    } catch (e) {
      setValue('');
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [opts]);

  useEffect(() => {
    regenerate();
  }, [regenerate]);

  const copy = async () => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const bits = error ? 0 : estimateEntropyBits(opts);
  const strength = strengthFromEntropy(bits);

  const toggle = (key: keyof PasswordOptions) => (checked: boolean) =>
    setOpts((o) => ({ ...o, [key]: checked }));

  return (
    <div className="grid gap-3">
      <pre className="min-h-11 break-all whitespace-pre-wrap rounded-lg border border-border bg-secondary px-3 py-2.5 font-mono text-sm">
        {value || '—'}
      </pre>
      <Progress value={STRENGTH_VALUE[strength] ?? 0} indicatorClassName={STRENGTH_BAR[strength]} />
      <p className={error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
        {error || `${bits} bits · ${strength}`}
      </p>

      <div className="grid gap-2">
        <p className="text-sm">Length: {opts.length}</p>
        <Slider
          min={8}
          max={64}
          value={[opts.length]}
          onValueChange={([v]) => setOpts((o) => ({ ...o, length: v ?? o.length }))}
        />
      </div>

      <CheckboxField label="Lowercase (a-z)" checked={opts.lowercase} onCheckedChange={toggle('lowercase')} />
      <CheckboxField label="Uppercase (A-Z)" checked={opts.uppercase} onCheckedChange={toggle('uppercase')} />
      <CheckboxField label="Digits (0-9)" checked={opts.digits} onCheckedChange={toggle('digits')} />
      <CheckboxField label="Symbols (!@#$)" checked={opts.symbols} onCheckedChange={toggle('symbols')} />
      <CheckboxField
        label="Exclude ambiguous"
        checked={opts.excludeAmbiguous}
        onCheckedChange={toggle('excludeAmbiguous')}
      />

      <div className="mt-1 flex justify-end gap-2">
        <Button variant="outline" onClick={regenerate}>
          <IconRefresh className="size-4" />
          Regenerate
        </Button>
        <Button variant="outline" disabled={!value} onClick={copy}>
          {copied ? <IconCheck className="size-4 text-emerald-600" /> : <IconCopy className="size-4" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        {onUse && (
          <Button disabled={!value} onClick={() => value && onUse(value)}>
            Use
          </Button>
        )}
      </div>
    </div>
  );
}
