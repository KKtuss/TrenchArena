import { readFileSync, writeFileSync } from 'node:fs';

const files = [
  'app/tournament/[id]/page.tsx',
  'app/casual/[roomId]/page.tsx',
  'app/casual/create/page.tsx',
  'app/result/[id]/page.tsx',
  'app/battle/[matchId]/page.tsx',
  'app/tournaments/page.tsx',
];

const importLine = "import { ErrorToast } from '@/components/error-toast';";

for (const file of files) {
  let source = readFileSync(file, 'utf8');
  if (!source.includes(importLine)) {
    const lines = source.split('\n');
    let insertAt = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].startsWith('import ')) insertAt = i + 1;
      else if (insertAt && !lines[i].startsWith('import ')) break;
    }
    lines.splice(insertAt, 0, importLine);
    source = lines.join('\n');
  }
  source = source.replaceAll(
    '{error ? <div className="error-banner">{error}</div> : null}',
    '<ErrorToast error={error} onDismiss={() => setError(null)} />',
  );
  writeFileSync(file, source);
  console.log(`patched ${file}`);
}
