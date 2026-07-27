/loop Run one round of the MiroFish-style cycling-audience simulation.

State: sim/sim-state.json. Each iteration:
1. Read sim/sim-state.json → find the next unrun round (R1 follower reactions →
   R2 influencer amplification → R3 brand/partnership fit). If converged, STOP.
2. Run: node sim/run-round.mjs --round <n> (agents in sim/personas.json react to
   sim/content-variants.json; results appended to sim-state.json).
3. Convergence: top-quartile variant ranking stable vs previous round
   (Kendall tau ≥ 0.9) OR round == 3 → mark converged.
4. On convergence: node sim/report.mjs (writes docs/audience-simulation-report.md
   + sim-predictions.json), then STOP.
Never re-run a completed round. One round per iteration.
