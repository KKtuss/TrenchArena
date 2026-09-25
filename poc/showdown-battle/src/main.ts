import {
  assertSameTerminalResult,
  replayBattle,
  runBattle,
} from './battle';

async function main(): Promise<void> {
  const result = await runBattle();
  const replay = await replayBattle(result.inputLog);
  assertSameTerminalResult(result.terminal, replay);

  console.log(JSON.stringify({
    showdownVersion: result.showdownVersion,
    showdownGitHead: result.showdownGitHead,
    formatId: result.formatId,
    winner: result.terminal.winner || 'tie',
    score: result.terminal.score,
    turns: result.terminal.turns,
    acceptedChoices: {
      p1: result.players.p1.choices.length,
      p2: result.players.p2.choices.length,
    },
    inputLogEntries: result.inputLog.length,
    rawEventCount: result.eventLog.raw.length,
    spectatorEventCount: result.eventLog.spectator.length,
  }, null, 2));
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
