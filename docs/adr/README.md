# Architecture Decision Records — agora

The order follows the picture: first the **split**, then the **pipe**, then how it's **delivered**,
then the **site**, then the **conversation**, then the **positioning**, then the **resume fast-path**,
then **state authority**, then the **durable store**.

1. [0001 — Product split: a site, runtimes, channels](0001-decoupage-produit.md) — **Proposed**
2. [0002 — The `channels` primitive as the pipe](0002-channels-primitive.md) — **Proposed**
3. [0003 — Monorepo + multi-artefacts (channel→plugin, website→image, shared→protocol)](0003-monorepo-artefacts.md) — **Proposed**
4. [0004 — Website = hub](0004-website-hub.md) — **Proposed**
5. [0005 — Conversation / history decoupling](0005-conversation-history.md) — **Accepted**, spike-confirmed 2026-06-30
6. [0006 — Adopt, don't build: the landscape and the decision](0006-adopter-not-builder.md) — **Proposed**
7. [0007 — Native resume as a fidelity fast-path over re-seed (anchor + delta)](0007-native-resume-anchor-delta.md) — **Accepted** 2026-07-04, validated 2026-07-02
8. [0008 — State authority: the hub reads a composed state; the reaper lives in the supervisor](0008-state-authority-and-idle-reaping.md) — **Proposed**, deployed 2026-07-03
9. [0009 — Durable conversation store on CNPG Postgres (two-tier state)](0009-conversation-store-cnpg.md) — **Accepted** 2026-07-04
