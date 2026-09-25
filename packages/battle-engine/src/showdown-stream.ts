import { BattleStream } from 'pokemon-showdown';

export interface ShowdownTerminalData {
  winner?: unknown;
  score?: unknown;
  turns?: unknown;
  p1?: unknown;
  p2?: unknown;
  inputLog?: unknown;
}

export class RecordingBattleStream extends BattleStream {
  readonly rawMessages: string[] = [];
  readonly terminal: Promise<ShowdownTerminalData>;
  private resolveTerminal!: (data: ShowdownTerminalData) => void;
  private rejectTerminal!: (error: Error) => void;

  constructor() {
    super();
    this.terminal = new Promise<ShowdownTerminalData>((resolve, reject) => {
      this.resolveTerminal = resolve;
      this.rejectTerminal = reject;
    });
  }

  override push(chunk: string): void {
    this.rawMessages.push(chunk);

    if (chunk.startsWith('end\n')) {
      try {
        const data: unknown = JSON.parse(chunk.slice('end\n'.length));
        if (!isRecord(data)) throw new Error('Showdown terminal payload is not an object.');
        this.resolveTerminal(data);
      } catch (error) {
        this.rejectTerminal(error instanceof Error ? error : new Error(String(error)));
      }
    }

    super.push(chunk);
  }
}

function isRecord(value: unknown): value is ShowdownTerminalData {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
