# Fluid Framework Research and Prototyping

**Project owner:** Gin Fu<br>
**Project type:** Product research and hands-on prototyping

This project asks a counterfactual question:

> If Fluid Framework did not exist, how would Microsoft build a collaborative canvas where people and AI agents work on the same durable artifact?

I pressure-tested the external path instead of starting from the assumption that Fluid should remain the default. The work combines a decision-oriented comparison of Fluid v2 / SharedTree against Yjs, Automerge, Loro, and Liveblocks with a working Automerge prototype for real-time collaboration and human-reviewed AI edits.

## Executive conclusion

For the scoped Microsoft product scenario, keep Fluid v2 / SharedTree as the default collaboration foundation.

External frameworks provide meaningful advantages at the mechanism and client layer: Yjs in collaborative text and editor integrations, Automerge in local-first history and merge reasoning, Loro in structural conflict semantics, and Liveblocks in packaging and developer experience. None currently provides a broad enough advantage to offset the Microsoft product path that would still need to be built around it: identity, permissions, trusted storage, governance, recovery, search and discovery, regional deployment, and long-running service ownership.

The recommendation is conditional rather than absolute. External frameworks are useful design pressure, and the decision should be reopened if collaborative text, AI-editing patterns, reliability, integration reuse, or deep-offline requirements materially change the trade-off.

## Why this decision matters

AI is moving from one-time chat responses into durable work artifacts such as pages, canvases, plans, briefs, and tasks. Once people and agents edit the same artifact, collaboration infrastructure determines more than synchronization. It defines:

1. What structured state an AI can target.
2. How people inspect and approve AI edits.
3. How the artifact persists, evolves, and recovers.
4. How identity, permissions, governance, and storage apply.
5. How ordering, conflict behavior, and state transitions remain understandable.

The project therefore compares complete adoption paths, not merge algorithms in isolation:

| Layer | Decision question |
|---|---|
| Mechanism / client layer | What collaboration behavior can the application deliver? |
| Product / platform layer | What must be integrated, deployed, governed, and operated for production use? |

## What I built

### Research

The analysis defines the decision requirements, compares four external frameworks against the replacement bar, connects the comparison to observed prototype behavior, and records the conditions that would change the recommendation.

Read [research/Fluid-Framework-Analysis.md](research/Fluid-Framework-Analysis.md).

### Prototype

The prototype is a React and Automerge application that demonstrates:

- A shared canvas with sticky notes, shapes, ink, presence, undo/redo, local persistence, and multi-user synchronization.
- A shared long-form text surface with remote carets and 1,000-word and 10,000-word stress samples.
- Private AI proposals that remain outside shared state until a person accepts them.
- Review controls for accept, reject, partial accept, and reject-and-revise feedback.
- Cross-note semantic review and same-note live-conflict preview with human-controlled commit.
- A small WebSocket relay and optional server-side AI proxy.

The prototype supports the client-layer finding: an external CRDT can produce credible collaboration and AI-review behavior quickly. It does not establish Microsoft production readiness, durable cloud storage, enterprise identity, compliance, or service ownership.

See [prototype/README.md](prototype/README.md) for architecture, setup, and evidence boundaries.

## Key findings

| Option | Strongest pressure on Fluid | Why it did not replace Fluid in this analysis |
|---|---|---|
| Yjs | Collaborative text, editor ecosystem, public adoption | Its strongest advantage is narrower than the multi-object, typed, governed artifact scenario. |
| Automerge | Local-first behavior, history, understandable document merge | The prototype proves client feasibility, while most review and semantic workflows are application logic built above Automerge. |
| Loro | Move/delete and other structural conflict semantics | The evidence is strongest for specific conflict cases rather than the complete product and platform path. |
| Liveblocks | Time-to-first-feature, collaboration packaging, public AI narrative | Its primary advantage is productized developer experience, not a clearly stronger foundation for typed, governed artifacts. |

The prototype also produced a product lesson independent of framework choice:

> AI edits should follow a proposal, review, and commit workflow rather than mutating shared state directly.

## Repository structure

```text
.
|-- README.md
|-- research/
|   `-- Fluid-Framework-Analysis.md
`-- prototype/
	|-- README.md
	|-- src/
	|-- scripts/
	|-- public/
	|-- server.mjs
	`-- package.json
```

## Run the prototype

```powershell
cd prototype
npm ci
npm run dev:all
```

Open `http://localhost:5173/?demo=playground` and join the same room from another tab or browser to test collaboration.

AI generation is optional. Without an AI backend, the collaboration features still run and the interface explains that AI generation is unavailable. See the prototype documentation for supported server-side environment variables.

## Evidence boundary

This repository is a public portfolio edition of the project. It contains public-source research and sanitized prototype code. It does not include raw stakeholder notes, internal meeting material, confidential roadmap details, internal metrics, credentials, or production service configuration. The recommendation is the project owner's research judgment, not an official Microsoft position.