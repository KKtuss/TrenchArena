import type { CasualRoomService } from '../src/casual-service';

export async function openFullCasualRoom(
  casual: CasualRoomService,
  creatorId = 'demo-player-1',
  opponentId = 'demo-player-2',
  collateral = 1_000,
  ruleset: 'casual' | 'competitive' = 'casual',
) {
  const room = await casual.createRoom({
    creatorId,
    roomType: 'open',
    battleSize: '1v1',
    collateral,
    ruleset,
  });
  await casual.acceptRoom(room.id, opponentId);
  return casual.getRoom(room.id, creatorId);
}

export function confirmCasualPicks(
  casual: CasualRoomService,
  roomId: string,
  playerId: string,
  slots: readonly number[] = [0, 1, 2],
) {
  return casual.selectTeam(roomId, playerId, slots, true);
}

export function bothReadyCasual(
  casual: CasualRoomService,
  roomId: string,
  creatorId = 'demo-player-1',
  opponentId = 'demo-player-2',
) {
  casual.setReady(roomId, creatorId, true);
  return casual.setReady(roomId, opponentId, true);
}

export function bothConfirmCasual(
  casual: CasualRoomService,
  roomId: string,
  creatorId = 'demo-player-1',
  opponentId = 'demo-player-2',
  creatorSlots: readonly number[] = [0, 1, 2],
  opponentSlots: readonly number[] = [0, 1, 2],
) {
  bothReadyCasual(casual, roomId, creatorId, opponentId);
  confirmCasualPicks(casual, roomId, creatorId, creatorSlots);
  return confirmCasualPicks(casual, roomId, opponentId, opponentSlots);
}
