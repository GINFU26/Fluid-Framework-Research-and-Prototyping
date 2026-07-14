# Fluid Framework Research Analysis

**Project:** Fluid Framework Research and Prototyping<br>
**Owner:** Gin Fu<br>
**Audience:** Fluid-aware technical and product reviewers<br>
**Last updated:** 2026-06-04

> **Public portfolio edition.** This document presents the project owner's research judgment based on public sources and the included prototype. It is not an official Microsoft position.

---

## 1. Context and Problem Framing

Microsoft AI experiences are moving beyond one-time chat responses toward durable work artifacts: pages, canvases, plans, briefs, tasks, and other shared objects that continue to evolve after they are generated. This shift changes how Microsoft should think about collaboration. If people and AI agents are expected to work on the same artifact, the system must support more than simple synchronization across clients.

In this context, the collaboration foundation defines the boundary of what AI can safely edit, what humans can trust, and how artifacts can persist across products. The collaboration foundation therefore matters. A weak foundation can limit what AI is able to safely edit, force product teams to redo integration work, and make artifacts harder to govern as they move across app surfaces.

To function well, a durable AI artifact needs structured state that AI can target, product experiences that people can understand and trust, reviewable changes, and a clear path for persistence and evolution within Microsoft products. The collaboration foundation ultimately determines what can be edited, reviewed, stored, recovered, governed, and operated over time.

With this context, this document evaluates which collaboration foundation best fits Microsoft collaborative AI-artifact scenarios, and whether Fluid v2 / SharedTree remains the right default.

---

## 2. Requirements for Human-Agent Artifacts

From that premise, the collaboration foundation must support five requirements:

| # | Requirement | What it means for the decision |
|---|---|---|
| 1 | Structured, targetable state | AI needs to reference and modify typed units such as sections, tasks, notes, nodes, or canvas objects, not only flat text. |
| 2 | Reviewable human workflows | AI edits should be attributable, inspectable, and optionally gated through proposal, review, and human acceptance. |
| 3 | Durable artifact lifecycle | The artifact must persist, evolve, recover, and remain useful beyond the active collaboration session. |
| 4 | Microsoft product integration | Identity, permissions, governance, audit, compliance, search, and storage expectations must apply to the artifact. |
| 5 | Meaningful collaboration semantics | The system needs ordering, conflict behavior, and state transitions that product teams can reason about. |

These requirements are not equal in replacement cost. Structured state, reviewable workflows, and Microsoft integration are significantly harder to retrofit and therefore carry more weight in evaluating alternatives.

---

## 3. Decision Question and Scope

For clarity, Fluid refers to Fluid Framework v2 with SharedTree as the primary data model in this document.

The decision question is:

> Given the need for durable human-agent artifacts, should Microsoft keep Fluid v2 / SharedTree as the default collaboration foundation, or seriously consider an external framework?

The comparator set is intentionally narrow: Yjs, Automerge, Loro, and Liveblocks. This is not a full market scan, but a targeted pressure test for this scenario.

---

## 4. Recommendation

Keep Fluid v2 / SharedTree as the default for the scoped Microsoft collaborative canvas and AI-artifact scenarios.

This is a threshold judgment. External frameworks should become the default only if their mechanism and client-layer advantages are strong enough to offset the platform cost defined in Section 5. Current evidence does not meet that bar.

Fluid v2 / SharedTree remains the stronger default because the target scenario (Section 1) is not just synchronization, but a durable artifact requiring structured state, review, and governance. Fluid provides a coherent path across both layers of the decision: a mechanism direction aligned with structured AI-edit workflows, and a Microsoft-owned product path for storage, governance, recovery, and operations.

External frameworks remain valuable as design pressure. They highlight gaps in collaborative text, local-first history, structural conflict handling, developer experience, and packaging. These should shape the Fluid roadmap, but they do not currently justify replacing Fluid as the default foundation.

In practice:

1. Continue with Fluid v2 / SharedTree as the default.
2. Treat external frameworks as design pressure, not replacements.
3. Ensure the Fluid roadmap absorbs the strongest external lessons.

---

## 5. Evaluation Model

Two ideas guide the rest of the analysis: mechanism value and replacement bar.

The comparison is Fluid v2 / SharedTree + Microsoft integration path already in motion versus an external framework + Microsoft integration path that would still need to be built.

This matters because a collaboration framework decision has two layers:

| Layer | Decision question |
|---|---|
| Mechanism / client layer | What collaboration behavior is enabled at the app layer? |
| Product / platform layer | What must Microsoft build and operate for production use? |

External frameworks can be strong at the mechanism layer, such as local-first editing, editor bindings, fast prototyping, and history.

However, Microsoft would need to build a trusted collaboration path around it:

- A live session service that coordinates active collaboration instead of relying on overwrite-style saves.
- SharePoint/ODSP integration that preserves access, sharing, permissions, labels, audit, recovery, search, and discovery expectations.
- Identity and permission handling that works on behalf of real Microsoft users and policies.
- Deployment and operations across the environments Microsoft products must support.
- Product projections so artifact content can participate in search, eDiscovery, compliance workflows, and AI grounding.

The replacement bar is high. An external framework must provide a decisive advantage to justify rebuilding this platform path.

---

## 6. Why Fluid v2 / SharedTree Fits

Fluid v2 / SharedTree matters here because it is both a Microsoft-integrated platform path and a mechanism direction that lines up with structured human-agent artifacts.

| # | Requirement from the premise | Fluid fit |
|---|---|---|
| 1 | AI can target structured state | SharedTree lets products model paragraphs, cards, tasks, notes, sections, and canvas objects as typed state instead of flattening the artifact into text. |
| 2 | Humans can review and trust edits | Branch/rebase direction, transactions, constraints, and typed operations support proposal-review-commit workflows. |
| 3 | Collaboration has a canonical order | Service ordering gives Microsoft a clear operation sequence for recovery, summaries, policy enforcement, and accountable service operation. |
| 4 | The artifact fits Microsoft product expectations | The Fluid path is already aligned with Microsoft-owned service, storage, governance, and product integration work in a way external frameworks would still need to recreate. |

The strongest mechanism case for Fluid is not "central service is always better." It is that service ordering, optimistic local edits, transactions, schema, and structured state form a coherent model for governed Microsoft artifacts. For human-agent workflows, that coherence matters. An AI proposal should be able to target a node, check that the referenced state still exists, produce a reviewable change, and commit only after human acceptance.

The strongest platform case is that Fluid is not being evaluated as a standalone SDK. It is part of a Microsoft-owned collaboration path that can connect to SharePoint/ODSP storage, product projections, governance, recovery, and operations. Those capabilities should not be attributed to the Fluid client alone. The point is the combined path.

This section is the positive case for Fluid as the default. It does not claim Fluid is finished; the unfinished work is consolidated in Section 9.

---

## 7. External Framework Comparisons

The external frameworks are not strawmen. Each is attractive for a real reason. The issue is whether any external option has enough mechanism and client-layer value to justify becoming the Microsoft default for this scenario today.

The table below tests each external option against the replacement bar. It defines what each framework is, where its strongest client value sits, and why that value does or does not justify replacing Fluid as the default.

| # | Framework | What it is | Client value | Why not replace |
|---|---|---|---|---|
| 1 | Yjs | CRDT-based shared data library with a mature JavaScript collaboration ecosystem, especially for text/editor integrations. | Strongest for collaborative text, rich editor bindings, and visible public adoption. | Not broad enough as the default for the full scenario today. Its clearest advantage is text-first collaboration, while this analysis targets multi-object AI artifacts with typed structure, review state, tasks, and product metadata. |
| 2 | Automerge | Local-first CRDT document library with merge, change history, and an understandable document mental model. | Strongest for local-first editing, history/merge reasoning, and fast client-side prototyping; the project prototype proves credible canvas plus AI-review behavior. | Not the default on current evidence. The prototype validates client feasibility, but much of its visible value comes from application and AI workflow above Automerge; local-first history is valuable, but not currently the dominant requirement. |
| 3 | Loro | CRDT library focused on structured documents, including list/tree/text data and conflict cases such as move/delete behavior. | Strongest for structural conflict semantics that matter when objects move, references change, or AI proposals target stale structure. | Not yet a replacement-level case. The mechanism is relevant, but current evidence is concentrated around specific structural cases rather than the full text, canvas, AI review, DX, and product-adoption scenario. |
| 4 | Liveblocks | Productized collaboration platform and developer experience layer, with rooms, presence, comments, notifications, Yjs integration, and AI-collaboration APIs. | Strongest for time-to-first-feature, collaboration packaging, and a clear public AI-collaboration narrative. | Not a default foundation replacement. Its strongest advantage is packaging and DX, not a clearly superior mechanism for durable, typed, governed human-agent artifacts. |

### 7.1 Overall Takeaway

At the mechanism level, the comparison is mixed. Each external framework has a real advantage, but each advantage is currently narrower than the full replacement decision.

For the current scenario, none of the external frameworks shows a mechanism/client-layer advantage broad enough to justify replacing Fluid v2 / SharedTree as the default foundation. Their value is still important: they identify the gaps Fluid needs to close and the conditions that would reopen the decision.

---

## 8. Prototype Evidence

The prototype narrows the analysis from framework claims to observed behavior. It was built with Automerge because Automerge was the most practical external mechanism for testing a collaborative canvas, shared text, private AI review, feedback loops, and semantic merge in a local React prototype.

The prototype shows that a third-party CRDT can produce credible client-side collaboration and AI-review behavior quickly. That matters because the external path is not theoretical. It also shows that the better product pattern is private proposal, human review, accepted commit, and visible source/decision context, rather than direct AI mutation.

The prototype does not prove that Automerge, or any external framework, is production-ready for Microsoft internal apps. It also does not prove trusted service operation, SharePoint/ODSP integration, Entra identity, audit, eDiscovery/search projection, regional deployment, compliance posture, or long-running service ownership.

| # | Prototype layer | What was built | What it proves | Does not prove |
|---|---|---|---|---|
| 1 | Shared workspace | Automerge-backed canvas, notes, shapes, ink, undo/redo, local persistence, presence, multi-tab sync, and shared text stress paths. | External CRDTs can create credible client-layer value for collaborative artifacts. | Microsoft production readiness or trusted platform integration. |
| 2 | Private AI review | AI proposals with preview, accept/reject, partial accept, and reject-and-revise feedback before commit. | The right AI artifact pattern is proposal, review, accept, and commit, not direct mutation. | That the review gate, feedback memory, or partial acceptance is native Automerge capability. These are application/AI workflows over shared state. |
| 3 | Semantic review | Cross-note semantic merge and same-note live-conflict preview, with shared mutation only after human acceptance. | Semantic tension can become a reviewable workflow over durable shared state. | That semantic detection or LLM resolution is native to the collaboration framework. |

The product lesson goes beyond the implementation choice. AI edits should follow a proposal -> review -> commit workflow.

Fluid has the required building blocks but lacks a canonical end-to-end pattern that makes this workflow easy to adopt. Closing this gap would turn the prototype into evidence for Fluid's roadmap rather than against it.

---

## 9. What Fluid Must Still Finish

The recommendation stays credible only if Fluid closes the main gaps exposed by the comparison and the prototype.

| # | Priority | Investment | Why it matters now |
|---|---|---|---|
| 1 | High | Land and validate SharedTree-heavy collaborative text for Pages-like artifacts. | Text is the most visible external pressure point and the gap most likely to affect real AI artifacts. |
| 2 | High | Define a canonical "Copilot edits a Fluid artifact" pattern. | Product teams need a clear, repeatable model for how AI proposes, reviews, and commits changes over shared state. |
| 3 | Medium | Produce an end-to-end SharePoint-backed starter path. | Fluid's Microsoft advantage must be visible in a realistic app path, not only understood by experts. |
| 4 | Medium | Improve first-feature developer experience. | Product teams choose what they can ship. External frameworks currently feel easier to start with. |
| 5 | Medium | Close the benchmark and reliability evidence gap. | External frameworks appear more credible when their evidence is visible and Fluid's remains implicit or internal-only. |

These are the conditions required for the recommendation to hold.

---

## 10. When to Reopen the Decision

The recommendation should be reopened if the external path becomes materially better for the full product decision, not just interesting at the mechanism layer.

| # | Trigger | Effect |
|---|---|---|
| 1 | SharedTree-heavy collaborative text is not viable for Pages-like text-heavy artifacts. | Yjs becomes a much stronger replacement pressure point. |
| 2 | Fluid's AI editing path remains unclear while external stacks become materially easier for product teams to ship. | Product teams may choose the path with clearer shippable patterns even if Fluid has deeper primitives. |
| 3 | Credible performance or reliability evidence shows Fluid cannot meet target-scenario scale, recovery, or latency needs. | The default should be re-evaluated against the strongest external options. |
| 4 | An external framework can reuse enough Microsoft service and ODSP infrastructure to materially lower platform cost. | The main integration-cost argument weakens. |
| 5 | Deep offline becomes a must-have M365 requirement and Fluid cannot close it on a credible timeline. | Automerge, Yjs, or Loro deserve stronger consideration, especially if paired with text/editor or history requirements. |

Current evidence does not show any of these conditions strongly enough to overturn the default.

---

## 11. Source Basis

### Public sources

Public package and release facts were checked on 2026-05-26. Public Microsoft product context was refreshed separately on 2026-06-01.

- [Fluid Framework documentation](https://fluidframework.com/docs/), [GitHub repository](https://github.com/microsoft/FluidFramework), and [GitHub releases](https://github.com/microsoft/FluidFramework/releases).
- Fluid Framework 2.101.1, `@fluidframework/tree-agent` 2.101.1, and `@fluidframework/tree-agent-langchain` 2.101.1 package information.
- Public Microsoft 365 Copilot, agents, data protection, and auditing materials.
- [Yjs documentation](https://docs.yjs.dev/) and [releases](https://github.com/yjs/yjs/releases): 13.6.30 stable plus 14.x prerelease tags.
- [Automerge documentation](https://automerge.org/docs/), [Automerge 3 announcement](https://automerge.org/blog/automerge-3/), and package information for Automerge 3.2.6 and Automerge Repo 2.5.6.
- [Loro documentation](https://loro.dev/docs) and [releases](https://github.com/loro-dev/loro/releases): Loro 1.12.3.
- [Liveblocks documentation](https://liveblocks.io/docs), changelog, AI Collaboration documentation, and public security/enterprise pages: Liveblocks 3.19.3.
- Public local-first and CRDT benchmark references, including [dmonad/crdt-benchmarks](https://github.com/dmonad/crdt-benchmarks) and [Ink & Switch's local-first essay](https://www.inkandswitch.com/essay/local-first/).
- First-hand implementation evidence from the Automerge prototype included in this repository: shared canvas and text, private AI review, feedback, semantic review, and live-conflict preview.

Private stakeholder notes, internal URLs, metrics, and roadmap material are intentionally outside this public evidence set. Claims that depend on non-public evidence should be treated as hypotheses to validate rather than official product commitments.
