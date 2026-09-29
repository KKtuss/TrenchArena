export interface PublicTrainerProfile {
  username: string;
  spriteId: string;
}

export function isPublicTrainerUsername(value: string): boolean {
  const name = value.trim();
  return name.length >= 2 && name.length <= 16 && /^[A-Za-z0-9 _-]+$/.test(name);
}

export function isPublicTrainerSpriteId(value: string): boolean {
  return /^[a-z0-9-]{2,64}$/.test(value.trim());
}

export class TrainerDirectory {
  private readonly byPlayer = new Map<string, PublicTrainerProfile>();

  set(playerId: string, input: { username: string; spriteId: string }): PublicTrainerProfile {
    const username = input.username.trim();
    if (!isPublicTrainerUsername(username)) {
      throw new Error('Username must be 2–16 letters, numbers, spaces, _ or -.');
    }
    const spriteId = input.spriteId.trim();
    if (!isPublicTrainerSpriteId(spriteId)) {
      throw new Error('Invalid trainer sprite.');
    }
    const profile = { username, spriteId };
    this.byPlayer.set(playerId, profile);
    return profile;
  }

  get(playerId: string): PublicTrainerProfile | undefined {
    return this.byPlayer.get(playerId);
  }

  displayName(playerId: string): string | undefined {
    return this.byPlayer.get(playerId)?.username;
  }

  snapshot(): Record<string, PublicTrainerProfile> {
    return Object.fromEntries(this.byPlayer);
  }

  namedView<T extends { sides: readonly [{ playerId: string; name: string }, { playerId: string; name: string }] }>(
    view: T | undefined,
  ): T | undefined {
    if (!view) return undefined;
    return {
      ...view,
      sides: view.sides.map(side => ({
        ...side,
        name: this.displayName(side.playerId) ?? side.name,
      })),
    } as T;
  }
}
