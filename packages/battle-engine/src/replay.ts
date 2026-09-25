import { ReplayMismatchError } from './errors';
import { RecordingBattleStream, type ShowdownTerminalData } from './showdown-stream';
import {
  SHOWDOWN_GIT_HEAD,
  SHOWDOWN_VERSION,
} from './teams';
import type { BattleReplay, BattleResult } from './types';

export async function replayBattle(replay: BattleReplay): Promise<BattleResult> {
  if (replay.showdownVersion !== SHOWDOWN_VERSION) {
    throw new Error(
      `Replay uses Showdown ${replay.showdownVersion}; this package uses ${SHOWDOWN_VERSION}.`,
    );
  }
  if (replay.showdownGitHead !== SHOWDOWN_GIT_HEAD) {
    throw new Error('Replay uses a different Showdown source revision.');
  }
  if (!replay.inputLog.length) throw new Error('Cannot replay an empty input log.');

  const stream = new RecordingBattleStream();
  await stream.write(replay.inputLog.join('\n'));
  const terminal = await stream.terminal;
  const actual = normalizeReplayResult(terminal, replay);

  if (JSON.stringify(actual) !== JSON.stringify(replay.result)) {
    throw new ReplayMismatchError(replay.result, actual);
  }

  return actual;
}

function normalizeReplayResult(
  data: ShowdownTerminalData,
  replay: BattleReplay,
): BattleResult {
  if (
    !Array.isArray(data.score) ||
    !data.score.every(item => typeof item === 'number') ||
    typeof data.turns !== 'number'
  ) {
    throw new Error('Replay terminal output has an invalid score or turn count.');
  }

  if (data.winner !== undefined && typeof data.winner !== 'string') {
    throw new Error('Replay terminal output has an invalid winner.');
  }
  const winnerName = data.winner ?? '';
  const winner = replay.players.find(player => player.name === winnerName)?.id;
  if (winnerName && !winner) {
    throw new Error(`Replay returned an unknown winner: ${winnerName}`);
  }

  return {
    status: winner ? 'win' : 'tie',
    ...(winner ? { winner } : {}),
    score: data.score,
    turns: data.turns,
  };
}
