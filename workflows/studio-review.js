export const meta = {
  name: 'studio-review',
  description: 'Five studio seats review one turn in parallel; each finding is adversarially verified before it becomes work',
  phases: [
    { title: 'Seats', detail: 'one seat per surface, each reading its own card as its charter' },
    { title: 'Verify', detail: 'refute each blocking finding before it costs an inner-loop pass' },
    { title: 'Advisory', detail: 'the platform advisor reads across what the seats signed' },
  ],
}

// The reviewable budget of one turn. The seats own a surface each and gate it;
// the advisor owns none and never gates. Step 3 of the turn owns the checkable
// budget and stays serial — verbs contend on one tree, one compose stack and one
// docker daemon, so fanning out the build buys collisions, not wall-clock.
//
// Scripts get no filesystem, so a seat reads its own card: teams/studio.md calls
// the card the agent's charter, verbatim, and that is how it arrives here.

const SEATS = ['backend', 'frontend', 'designer', 'ux', 'qa']

const FINDINGS = {
  type: 'object',
  properties: {
    seat: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['blocking', 'advisory'] },
          surface: { type: 'string' },
          // The invariant that must hold. Binding.
          required_property: { type: 'string' },
          // The evidence it does not hold. Binding.
          evidence: { type: 'string' },
          // One example route to the property. NEVER an instruction.
          fix_hint: { type: 'string' },
        },
        required: ['id', 'severity', 'required_property', 'evidence'],
      },
    },
    outcome: { type: 'string', enum: ['reviewed', 'nothing_to_report', 'could_not_look'] },
    reason: { type: 'string' },
  },
  required: ['seat', 'findings', 'outcome', 'reason'],
}

const VERDICT = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    why: { type: 'string' },
  },
  required: ['refuted', 'why'],
}

// Every seat reports the same shape however its review ended: a reader that
// meets a missing bucket cannot tell an empty one from a seat that never got
// that far, and the buckets are read after all five have been paid for.
const seatResult = (seat, outcome, reason, parts = {}) => ({
  seat,
  outcome,
  reason,
  advisory: [],
  blocking: [],
  unverified: [],
  raised: 0,
  ...parts,
})

// Substituting prose for a missing argument gives five seats a placeholder to
// review and lets every one of them report that it reviewed something.
if (!args?.context || !args?.ir) {
  throw new Error("studio-review needs args {context, ir}: what to review, and the ir to review it against")
}
const context = args.context
const ir = args.ir
const routes = args.routes
for (const name of ['review', 'risk', 'advisor']) {
  const route = routes?.[name]
  if (typeof route?.model !== 'string' || !route.model.trim() ||
      !['low', 'medium', 'high', 'xhigh', 'max'].includes(route.effort)) {
    throw new Error(`studio-review needs args.routes.${name} with model and effort`)
  }
}
const routeOptions = (name) => ({ model: routes[name].model, effort: routes[name].effort })
const seatRoute = (seat) => routeOptions(seat === 'backend' ? 'risk' : 'review')

// pipeline, not parallel: a seat's findings start verifying while the slower
// seats are still reading. The barrier would cost the fast seats their lead.
const reviewed = await pipeline(
  SEATS,
  (seat) =>
    agent(
      `You are pronto's ${seat} seat. Your charter names the one surface you own ` +
        `and the section you sign; report on that surface only.\n\n` +
        `Review ${context} against ${ir}. Report only on your own surface; another seat ` +
        `owns the rest and will say so itself.\n\n` +
        `A finding is BLOCKING only when you can name the invariant that must hold and the ` +
        `evidence that it does not. Anything you merely dislike is advisory.\n\n` +
        `If your surface is untouched by this turn, that is outcome nothing_to_report and it ` +
        `is a good result. If you needed to look at something you could not reach, that is ` +
        `could_not_look and you must name what stopped you. Never report one as the other.`,
      { label: `seat:${seat}`, phase: 'Seats', agentType: `pronto:${seat}`, schema: FINDINGS, ...seatRoute(seat) },
    ),
  (review, seat) => {
    // A seat that died and a seat that found nothing are different results, and
    // a shape that reports both as an empty finding list is the conflation the
    // turn's own report forbids. The outcome rides along so the turn can tell
    // a quiet surface from one nobody looked at.
    if (!review) return seatResult(seat, 'died', 'no result')
    // Findings are evidence the seat looked, whatever outcome it claims; dropping
    // them because the outcome disagrees would report a blocking finding as a
    // quiet surface.
    if (review.outcome !== 'reviewed' && review.findings.length === 0) {
      return seatResult(seat, review.outcome, review.reason)
    }
    const advisory = review.findings.filter((f) => f.severity === 'advisory')
    const blocking = review.findings.filter((f) => f.severity === 'blocking')
    if (blocking.length === 0) return seatResult(seat, 'reviewed', review.reason, { advisory })
    return parallel(
      blocking.map((f) => () =>
        agent(
          `Try to REFUTE this finding from pronto's ${seat} seat.\n\n` +
            `Required property: ${f.required_property}\n` +
            `Evidence offered: ${f.evidence}\n\n` +
            `Read the actual code and the ir before answering. A finding survives only if the ` +
            `property genuinely does not hold. Default to refuted:true when you are uncertain — ` +
            `a false finding costs an inner-loop pass, and the seat can raise it again.`,
          { label: `verify:${seat}:${f.id}`, phase: 'Verify', schema: VERDICT, ...seatRoute(seat) },
          // A verifier that did not answer did not refute. Both ways of failing
          // to answer — a null return, and a throw parallel() turns into one —
          // land in the same bucket, which is neither confirmed nor dropped.
        )
          .then((v) =>
            // A verdict without `refuted` answered off-schema, and the prompt says to
            // refute when uncertain.
            v?.refuted === false ? { f, verdict: 'confirmed' } : v?.refuted === true ? null : { f, verdict: 'unverified' })
          .catch(() => ({ f, verdict: 'unverified' })),
      ),
    ).then((judged) => {
      const kept = judged.filter(Boolean)
      return seatResult(seat, 'reviewed', review.reason, {
        advisory,
        raised: blocking.length,
        blocking: kept.filter((k) => k.verdict === 'confirmed').map((k) => k.f),
        unverified: kept.filter((k) => k.verdict === 'unverified').map((k) => k.f),
      })
    })
  },
)

// pipeline drops an item to null when its stage throws, taking the seat's name
// down with the result.
const seats = reviewed.map((r, i) => r ?? seatResult(SEATS[i], 'died', 'stage threw'))
const confirmed = seats.flatMap((r) => r.blocking.map((f) => ({ ...f, seat: r.seat })))
const unverified = seats.flatMap((r) => r.unverified.map((f) => ({ ...f, seat: r.seat })))
const advisories = seats.flatMap((r) => r.advisory.map((f) => ({ ...f, seat: r.seat })))
// A seat with nothing on its surface looked and found nothing, which is a
// result; only a seat that could not look, or died trying, leaves a gap.
// `raised` counts what a seat put forward, not what survived, so a seat whose
// every finding was refuted still said something.
const LOOKED = ['reviewed', 'nothing_to_report']
const silent = seats
  .filter((r) => LOOKED.includes(r.outcome) && r.raised === 0 && r.advisory.length === 0)
  .map((r) => r.seat)
const unseen = seats
  .filter((r) => !LOOKED.includes(r.outcome))
  .map((r) => `${r.seat} (${r.outcome}: ${r.reason})`)
log(
  `${confirmed.length} confirmed, ${unverified.length} unverified, ${advisories.length} advisory; ` +
    `quiet: ${silent.join(', ') || 'none'}; could not look: ${unseen.join(', ') || 'none'}`
)

phase('Advisory')
const advisory = await agent(
  `You are pronto's platform advisor. You own no surface: read across what the ` +
    `five seats signed over ${context} ` +
    `and report on how the work is written and how it is joined — seams used or worked around, ` +
    `couplings that earn their place, ideas tested outside the constraint.\n\n` +
    `The seats reported these confirmed blocking findings:\n` +
    (confirmed.map((f) => `- [${f.seat}] ${f.required_property}`).join('\n') || '- none') +
    `\n\nYou are advisory forever. Nothing you write gates this turn; say what you see.`,
  { label: 'advisor', phase: 'Advisory', agentType: 'pronto:platform-advisor', ...routeOptions('advisor') },
)

return { confirmed, unverified, advisories, silent, unseen, advisory }
