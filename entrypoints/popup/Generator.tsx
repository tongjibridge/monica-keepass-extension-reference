import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Checkbox,
  Code,
  CopyButton,
  Group,
  Progress,
  Slider,
  Stack,
  Text,
} from '@mantine/core';
import { IconCheck, IconCopy, IconRefresh } from '@tabler/icons-react';
import {
  DEFAULT_PASSWORD_OPTIONS,
  estimateEntropyBits,
  generatePassword,
  strengthFromEntropy,
  type PasswordOptions,
} from '@/src/crypto/generator';

const STRENGTH_COLOR: Record<string, string> = {
  weak: 'red',
  fair: 'yellow',
  good: 'lime',
  strong: 'teal',
};
const STRENGTH_VALUE: Record<string, number> = { weak: 25, fair: 50, good: 75, strong: 100 };

export function Generator({ onUse }: { onUse?: (password: string) => void }) {
  const [opts, setOpts] = useState<PasswordOptions>(DEFAULT_PASSWORD_OPTIONS);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

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

  const bits = error ? 0 : estimateEntropyBits(opts);
  const strength = strengthFromEntropy(bits);

  const toggle = (key: keyof PasswordOptions) => (checked: boolean) =>
    setOpts((o) => ({ ...o, [key]: checked }));

  return (
    <Stack gap="sm">
      <Code block style={{ minHeight: 44, fontSize: 14, wordBreak: 'break-all' }}>
        {value || '—'}
      </Code>
      <Progress value={STRENGTH_VALUE[strength] ?? 0} color={STRENGTH_COLOR[strength] ?? 'gray'} size="sm" />
      <Text size="xs" c={error ? 'red' : 'dimmed'}>
        {error || `${bits} bits · ${strength}`}
      </Text>

      <div>
        <Text size="sm" mb={4}>
          Length: {opts.length}
        </Text>
        <Slider
          min={8}
          max={64}
          value={opts.length}
          onChange={(v) => setOpts((o) => ({ ...o, length: v }))}
        />
      </div>

      <Checkbox label="Lowercase (a-z)" checked={opts.lowercase} onChange={(e) => toggle('lowercase')(e.currentTarget.checked)} />
      <Checkbox label="Uppercase (A-Z)" checked={opts.uppercase} onChange={(e) => toggle('uppercase')(e.currentTarget.checked)} />
      <Checkbox label="Digits (0-9)" checked={opts.digits} onChange={(e) => toggle('digits')(e.currentTarget.checked)} />
      <Checkbox label="Symbols (!@#$)" checked={opts.symbols} onChange={(e) => toggle('symbols')(e.currentTarget.checked)} />
      <Checkbox
        label="Exclude ambiguous"
        checked={opts.excludeAmbiguous}
        onChange={(e) => toggle('excludeAmbiguous')(e.currentTarget.checked)}
      />

      <Group justify="flex-end" gap="xs" mt="xs">
        <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={regenerate}>
          Regenerate
        </Button>
        <CopyButton value={value}>
          {({ copied, copy }) => (
            <Button
              variant="default"
              leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
              onClick={copy}
              disabled={!value}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
        </CopyButton>
        {onUse && (
          <Button onClick={() => value && onUse(value)} disabled={!value}>
            Use
          </Button>
        )}
      </Group>
    </Stack>
  );
}
