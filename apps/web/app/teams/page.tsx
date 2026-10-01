'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { PokemonSprite } from '@/components/showdown-visuals';
import { ProfileTrainerSprite } from '@/components/profile-trainer';
import { useArena } from '@/lib/arena-context';
import { activateTeam, readAllFormatTeams, type SavedTeam } from '@/lib/team';
import { formatById, formatLabel } from '@/lib/tournament-formats';
import { shortenAddress } from '@/lib/trainer-profile';

type ListedTeam = SavedTeam & { rulesetId: string };

export default function TeamsPage() {
  const router = useRouter();
  const { playerId, walletConnected, connectInjectedWallet, connectingWallet, trainerSpriteId } = useArena();
  const [teams, setTeams] = useState<ListedTeam[]>([]);

  useEffect(() => {
    setTeams(playerId ? readAllFormatTeams(playerId) : []);
  }, [playerId]);

  const openTeam = (rulesetId = 'gen9ou', id?: string) => {
    if (playerId && id) activateTeam(playerId, id, rulesetId);
    router.push(`/teams/builder?ruleset=${rulesetId}`);
  };

  return (
    <div className="pa-page">
      <header className="pa-page-head pa-page-head-row">
        <div>
          <h1>My Teams</h1>
          <p className="pa-lead">Saved teams by tournament format. A Gen 4 Cup team is not interchangeable with Gen 9 OU.</p>
        </div>
        {walletConnected ? (
          <button type="button" className="pa-btn pa-btn-primary" onClick={() => openTeam()}>
            Open team builder
          </button>
        ) : (
          <button
            type="button"
            className="pa-btn pa-btn-primary"
            disabled={connectingWallet}
            onClick={() => void connectInjectedWallet()}
          >
            {connectingWallet ? 'Connecting…' : 'Connect wallet'}
          </button>
        )}
      </header>

      {!walletConnected ? (
        <p className="pa-empty">Connect a Solana wallet to load and save a trainer-scoped team.</p>
      ) : teams.length ? (
        teams.map(team => {
          const format = formatById(team.rulesetId);
          const slots = Array.from({ length: 6 }, (_, index) => team.species[index] ?? '');
          return (
            <section key={`${team.rulesetId}:${team.id}`} className="pa-team-file">
              <header className="pa-team-file-head">
                <ProfileTrainerSprite label={playerId ?? 'You'} spriteId={trainerSpriteId} />
                <div>
                  <small>
                    {formatLabel(team.rulesetId)}
                    {' · '}
                    {playerId ? shortenAddress(playerId) : '—'}
                  </small>
                  <h2>{team.name}</h2>
                  <p className={team.validated ? 'ok' : 'warn'}>
                    {team.validated
                      ? `${format?.title ?? formatLabel(team.rulesetId)} · Legal`
                      : `${format?.title ?? formatLabel(team.rulesetId)} · Needs changes`}
                  </p>
                </div>
              </header>
              <div className="pa-team-slots">
                {slots.map((name, index) => (
                  <div key={index} className="pa-team-slot">
                    <small>Slot {String(index + 1).padStart(2, '0')}</small>
                    {name ? (
                      <PokemonSprite name={name} framed />
                    ) : (
                      <span className="ps-sprite-frame empty" aria-hidden />
                    )}
                    <strong>{name || 'Empty'}</strong>
                  </div>
                ))}
              </div>
              <p className="pa-team-names">
                {slots.filter(Boolean).join(' · ') || 'No species yet.'}
              </p>
              <button
                type="button"
                className="pa-btn pa-btn-primary pa-btn-sm"
                onClick={() => openTeam(team.rulesetId, team.id)}
              >
                Edit team
              </button>
            </section>
          );
        })
      ) : (
        <section className="pa-team-file pa-team-empty">
          <p>No saved teams for this profile yet. Pick a format in the builder and save one.</p>
          <Link className="pa-btn pa-btn-primary" href="/teams/builder">Open team builder</Link>
        </section>
      )}
    </div>
  );
}
