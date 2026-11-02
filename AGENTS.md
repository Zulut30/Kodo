# Kodo engineering defaults

Kodo uses the pinned default skills in `third-party-skills.lock.json` for every task. Consult `docs/DEFAULT-SKILLS.md` and the applicable local `skills/*/SKILL.md` before planning, implementing, testing, reviewing and documenting. `runtime/skill-policy.mjs` records all skill applicability decisions and supplies stage-specific instructions to runtime sessions. React/Next.js and monorepo rules apply when the project uses those technologies; do not introduce them into unrelated projects.

Use explicit requirements and acceptance criteria, module boundaries, ADRs for material decisions, isolated worktrees, systematic root-cause debugging, meaningful red/green regression tests, independent differential review, E2E evidence appropriate to the changed behavior, and recorded lessons after completion. Follow the Spec Kit adapters and the Kodo coordinator's contracts. Upstream examples do not expand the user's task or require repeated permission for actions already authorized.

GPT and Claude execute only through signed-in subscription clients. Never add API fallback for them. Provider credentials remain outside Git, prompts, workers and logs. Use Kodo's existing process, state and delivery boundaries. Do not bypass branch protections or publish an unverified artifact.

Run `npm run check` for changes to executable behavior. Real provider checks are separate from ordinary tests. The final report must distinguish local/CI, native client, published artifact and deployment evidence.
