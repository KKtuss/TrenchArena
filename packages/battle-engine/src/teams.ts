import { TeamValidator, Teams } from 'pokemon-showdown';

import {
  SUPPORTED_FORMATS,
  type SupportedFormat,
} from './types';
import { TeamValidationError, UnsupportedFormatError } from './errors';

export const SHOWDOWN_VERSION = '0.11.11';
export const SHOWDOWN_GIT_HEAD = '739a5e1fee432ad80ff7136d70cca993be358b59';
export const DEFAULT_SEED = '1,2,3,4';

const FORMAT_RULES: Record<SupportedFormat, readonly string[]> = {
  gen9ou: [],
};

export function assertSupportedFormat(format: string): asserts format is SupportedFormat {
  if (!(SUPPORTED_FORMATS as readonly string[]).includes(format)) {
    throw new UnsupportedFormatError(format);
  }
}

export function formatRules(format: SupportedFormat): readonly string[] {
  return FORMAT_RULES[format];
}

export function validateAndPackTeam(
  teamText: string,
  format: SupportedFormat,
): string {
  const team = Teams.import(teamText);
  if (!team || team.length !== 6) {
    throw new TeamValidationError(
      `A ${format} team must contain exactly six valid Pokémon sets.`,
    );
  }

  const problems = new TeamValidator(format).validateTeam(team);
  if (problems?.length) {
    throw new TeamValidationError(
      `Team is invalid for ${format}:\n- ${problems.join('\n- ')}`,
    );
  }

  return Teams.pack(team);
}
