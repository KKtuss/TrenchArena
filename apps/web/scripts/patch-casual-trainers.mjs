import { readFileSync, writeFileSync } from 'node:fs';

const path = 'app/casual/[roomId]/page.tsx';
let source = readFileSync(path, 'utf8');
source = source
  .replaceAll('<TrainerSprite label={yourId} side="left" />', '<ProfileTrainerSprite label={yourId} side="left" />')
  .replaceAll('<strong>{yourId}</strong>', '<strong>{shortenAddress(yourId)}</strong>')
  .replaceAll(
    '{rivalId ? <TrainerSprite label={rivalId} side="right" /> : <span className="pa-fight-open" aria-hidden />}',
    '{rivalId ? <ProfileTrainerSprite label={rivalId} side="right" /> : <span className="pa-fight-open" aria-hidden />}',
  )
  .replaceAll(
    '<strong>{rivalId ?? \'Waiting…\'}</strong>',
    '<strong>{rivalId ? shortenAddress(rivalId) : \'Waiting…\'}</strong>',
  )
  .replaceAll('Open seat', 'Open seat');
if (!source.includes('ProfileTrainerSprite')) {
  throw new Error('ProfileTrainerSprite not applied');
}
writeFileSync(path, source);
console.log('patched casual room trainers');
