'use client';

import { useEffect, useState } from 'react';

import { TeamBuilder } from '@/components/team-builder';
import { formatById } from '@/lib/tournament-formats';

import './builder.css';

export default function TeamBuilderPage() {
  const [rulesetId, setRulesetId] = useState<string | null>(null);
  const [tournamentId, setTournamentId] = useState<string | undefined>();
  const [formatLocked, setFormatLocked] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('ruleset') ?? 'gen9ou';
    const fromTournament = params.get('tournament') ?? undefined;
    setRulesetId(formatById(requested)?.id ?? 'gen9ou');
    setTournamentId(fromTournament);
    setFormatLocked(Boolean(fromTournament));
  }, []);

  if (!rulesetId) return null;
  return (
    <TeamBuilder
      initialRulesetId={rulesetId}
      tournamentId={tournamentId}
      formatLocked={formatLocked}
    />
  );
}
