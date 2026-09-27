'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { PokemonSprite } from '@/components/showdown-visuals';
import { ProfileTrainerSprite } from '@/components/profile-trainer';
import { useArena } from '@/lib/arena-context';
import { activateTeam, readRoster, type SavedRoster } from '@/lib/team';
import { shortenAddress } from '@/lib/trainer-profile';

export default function TeamsPage() {
  const router = useRouter();
  const { playerId, walletConnected, connectInjectedWallet, connectingWallet, trainerSpriteId } = useArena();
  const [roster, setRoster] = useState<SavedRoster>({ activeId: '', teams: [] });

  useEffect(() => {
    setRoster(playerId ? readRoster(playerId) : { activeId: '', teams: [] });
  }, [playerId]);

  const openTeam = (id?: string) => {
    if (playerId && id) activateTeam(playerId, id);
    router.push('/teams/builder');
  };

  return (
    <div className="pa-page">
      <header className="pa-page-head pa-page-head-row">
        <div>
          <p className="pa-kicker"><i /> — Competitive rosters —</p>
          <h1>My Teams</h1>
          <p className="pa-lead">Saved Gen 9 OU teams for this trainer profile.</p>
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
      ) : roster.teams.length ? (
        roster.teams.map(team => {
          const slots = Array.from({ length: 6 }, (_, index) => team.species[index] ?? '');
          return (
            <section key={team.id} className="pa-team-file">
              <header className="pa-team-file-head">
                <ProfileTrainerSprite label={playerId ?? 'You'} spriteId={trainerSpriteId} />
                <div>
                  <small>
                    {team.id === roster.activeId ? 'Active team' : 'Saved team'}
                    {' · '}
                    {playerId ? shortenAddress(playerId) : '—'}
                  </small>
                  <h2>{team.name}</h2>
                  <p className={team.validated ? 'ok' : 'warn'}>
                    {team.validated ? 'Passes Gen 9 OU.' : 'Draft. The validator still has problems.'}
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
              <button type="button" className="pa-btn pa-btn-primary pa-btn-sm" onClick={() => openTeam(team.id)}>
                Edit team
              </button>
            </section>
          );
        })
      ) : (
        <section className="pa-team-file pa-team-empty">
          <p>No saved team for this profile. The editor opens on the demo team.</p>
          <Link className="pa-btn pa-btn-primary" href="/teams/builder">Open team builder</Link>
        </section>
      )}
    </div>
  );
}
