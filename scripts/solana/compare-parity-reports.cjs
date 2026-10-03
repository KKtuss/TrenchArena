#!/usr/bin/env node
/**
 * Diff Anchor vs Pinocchio parity campaign JSON reports (test-only).
 *
 * Success criteria (from plan): same accept/reject outcomes and no unexpected
 * state mutation. Custom error *codes* may differ when Anchor returns
 * constraint/framework errors (2xxx) vs Pinocchio ArenaError (6000+N); those
 * are recorded as expectedNotes, not hard failures.
 */
const { readFileSync, writeFileSync } = require('node:fs');

const [aPath, bPath, outPath] = process.argv.slice(2);
if (!aPath || !bPath || !outPath) {
  console.error('Usage: compare-parity-reports.cjs <anchor.json> <pinocchio.json> <diff.json>');
  process.exit(2);
}

const A = JSON.parse(readFileSync(aPath, 'utf8'));
const B = JSON.parse(readFileSync(bPath, 'utf8'));

const byId = (rep) => Object.fromEntries(rep.cases.map((c) => [c.id, c]));
const aMap = byId(A);
const bMap = byId(B);
const ids = [...new Set([...Object.keys(aMap), ...Object.keys(bMap)])].sort();

const discrepancies = [];
const expectedNotes = [];
const matched = [];

function isAnchorFrameworkCode(code) {
  // Anchor constraint / account errors live below the #[error_code] 6000 band.
  return typeof code === 'number' && code > 0 && code < 6000;
}

for (const id of ids) {
  const a = aMap[id];
  const b = bMap[id];
  if (!a || !b) {
    discrepancies.push({
      id,
      kind: 'missing-case',
      detail: !a ? 'missing in Anchor report' : 'missing in Pinocchio report',
      expected: false,
    });
    continue;
  }
  const hard = [];
  const soft = [];

  if (a.ok !== b.ok) {
    hard.push(`ok mismatch: Anchor=${a.ok} Pinocchio=${b.ok}`);
  }
  if (a.expectReject !== b.expectReject) {
    hard.push('expectReject mismatch');
  }

  if (!a.ok && !b.ok && a.customError != null && b.customError != null && a.customError !== b.customError) {
    // Both rejected: code divergence is OK when Anchor uses framework constraints
    // or init-account failures (often surfaced as 0 / 2xxx) while Pinocchio returns
    // explicit ArenaError 6000+N with the same security outcome.
    const expectedDivergence =
      a.customError === 0 ||
      b.customError === 0 ||
      isAnchorFrameworkCode(a.customError) ||
      isAnchorFrameworkCode(b.customError) ||
      // Both in ArenaError band but different variant — still flag hard.
      false;
    if (expectedDivergence && !(a.customError >= 6000 && b.customError >= 6000 && a.customError !== b.customError)) {
      soft.push(`customError Anchor=${a.customError} Pinocchio=${b.customError} (both reject; framework vs ArenaError)`);
    } else if (a.customError !== b.customError) {
      // Same band different codes → real semantic drift risk
      if (a.customError >= 6000 && b.customError >= 6000) {
        hard.push(`ArenaError mismatch Anchor=${a.customError} Pinocchio=${b.customError}`);
      } else {
        soft.push(`customError Anchor=${a.customError} Pinocchio=${b.customError} (both reject)`);
      }
    }
  }

  const deltaKeys = new Set([...Object.keys(a.deltas || {}), ...Object.keys(b.deltas || {})]);
  for (const k of deltaKeys) {
    if (k === 'winner' || k === 'recipient' || k === 'swap') continue;
    const av = a.deltas?.[k];
    const bv = b.deltas?.[k];
    if (av !== undefined && bv !== undefined && av !== bv) {
      hard.push(`delta.${k}: Anchor=${av} Pinocchio=${bv}`);
    }
  }
  const accKeys = new Set([...Object.keys(a.accounts || {}), ...Object.keys(b.accounts || {})]);
  for (const k of accKeys) {
    const aa = a.accounts?.[k];
    const ba = b.accounts?.[k];
    if (!aa || !ba) continue;
    if (aa.exists !== ba.exists) hard.push(`account.${k}.exists mismatch`);
    if (aa.exists && ba.exists) {
      if (aa.dataSha256 && ba.dataSha256 && aa.dataSha256 !== ba.dataSha256) {
        hard.push(`account.${k}.dataSha256 mismatch`);
      }
      if (aa.lamports !== ba.lamports) {
        hard.push(`account.${k}.lamports Anchor=${aa.lamports} Pinocchio=${ba.lamports}`);
      }
      if (aa.owner && ba.owner && aa.owner !== ba.owner) {
        hard.push(`account.${k}.owner mismatch`);
      }
    }
  }

  if (hard.length) {
    discrepancies.push({
      id,
      ix: a.ix,
      category: a.category,
      kind: 'behavior',
      detail: hard.join('; '),
      expected: false,
      anchor: { ok: a.ok, customError: a.customError },
      pinocchio: { ok: b.ok, customError: b.customError },
    });
  } else {
    matched.push(id);
    if (soft.length) {
      expectedNotes.push({
        id,
        ix: a.ix,
        detail: soft.join('; '),
        expected: true,
        anchor: { ok: a.ok, customError: a.customError },
        pinocchio: { ok: b.ok, customError: b.customError },
      });
    }
  }
}

const coveredIx = [...new Set(A.cases.map((c) => c.ix))].sort();
const report = {
  generatedAt: new Date().toISOString(),
  anchor: { impl: A.impl, programDataLen: A.programDataLen, summary: A.summary },
  pinocchio: { impl: B.impl, programDataLen: B.programDataLen, summary: B.summary },
  matchedCases: matched.length,
  discrepancyCount: discrepancies.length,
  expectedErrorCodeNotes: expectedNotes.length,
  discrepancies,
  expectedNotes,
  instructionCoverage: coveredIx,
  verdict:
    discrepancies.length === 0 &&
    A.summary.unexpectedOk === 0 &&
    A.summary.unexpectedReject === 0 &&
    B.summary.unexpectedOk === 0 &&
    B.summary.unexpectedReject === 0
      ? 'PASS'
      : 'FAIL',
};

writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      verdict: report.verdict,
      matchedCases: report.matchedCases,
      discrepancyCount: report.discrepancyCount,
      expectedErrorCodeNotes: report.expectedErrorCodeNotes,
      anchorCases: A.summary.total,
      pinocchioCases: B.summary.total,
      instructions: coveredIx,
    },
    null,
    2,
  ),
);
if (report.verdict !== 'PASS') {
  console.error('DIFF FAIL — see', outPath);
  for (const d of discrepancies.slice(0, 50)) {
    console.error(`- ${d.id}: ${d.detail}`);
  }
  process.exit(1);
}
console.log('DIFF PASS — behavioral parity (accept/reject + state) holds.');
if (expectedNotes.length) {
  console.log(`Noted ${expectedNotes.length} expected error-code divergences (framework vs ArenaError).`);
}
