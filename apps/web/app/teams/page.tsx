'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { PokemonSprite, TrainerSprite } from '@/components/showdown-visuals';
import { useArena } from '@/lib/arena-context';
import { readSavedTeam, type SavedTeam } from '@/lib/team';

export default function TeamsPage() {
  const { playerId } = useArena();
  const [team, setTeam] = useState<SavedTeam | null>(null);

  useEffect(() => {
    setTeam(readSavedTeam(playerId));
  }, [playerId]);

  const slots = Array.from({ length: 6 }, (_, index) => team?.species[index] ?? '');

  return (
    <div className="pa-page">
      <header className="pa-page-head pa-page-head-row">
        <div>
          <p className="pa-kicker"><i /> — Competitive rosters —</p>
          <h1>My Teams</h1>
          <p className="pa-lead">Saved Gen 9 OU protocols for this trainer profile.</p>
        </div>
        <Link className="pa-btn pa-btn-primary" href="/teams/builder">
          {team ? 'Edit team' : 'Open team builder'}
        </Link>
      </header>

      {team ? (
        <section className="pa-team-file">
          <header className="pa-team-file-head">
            <TrainerSprite label={playerId} />
            <div>
              <small>Deployment file · {playerId}</small>
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
          <Link className="pa-btn pa-btn-primary pa-btn-sm" href="/teams/builder">Edit team</Link>
        </section>
      ) : (
        <section className="pa-team-file pa-team-empty">
          <p>No saved protocol for this profile. The editor opens on the demo team.</p>
          <Link className="pa-btn pa-btn-primary" href="/teams/builder">Open team builder</Link>
        </section>
      )}
    </div>
  );
}
