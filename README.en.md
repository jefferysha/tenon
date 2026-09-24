# Tenon

Local-first workflow governance for coding agents: explicit state, real Skill
provenance, review receipts, and a dashboard that reflects the workflow actually
being run.

[Online documentation](https://jefferysha.github.io/tenon/en/) ·
[简体中文](README.md) · [Repository guide](docs/usage/README.md) ·
[Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [MIT License](LICENSE)

Tenon is one packaged plugin, not a CLI plus a list of Skills to install
by hand. The release contains declarative workflows, OpenSpec evidence rules,
phase Skills, hooks, the CLI, the local Dashboard, automation controls, and
multi-host adapters.

It is built for a common failure mode in agent work: the conversation says one
thing while the task state, Todo list, documents, and actual tool execution say
another. Tenon keeps those surfaces on one effective workflow plan and
refuses invalid transitions instead of reconstructing progress from prose.

<img src="docs-site/public/images/dashboard-overview.webp" alt="Tenon Dashboard project overview" width="1280" height="720">

<p align="center"><sub>One local control plane for projects, real workflows, and items that need attention.</sub></p>

## What changes

| Without workflow governance | With Tenon |
| --- | --- |
| An old task can be resumed because it happens to be recent. | A Change is resumed only when the request identifies or explicitly resumes it. |
| A generic Todo can drift from the real process. | Todo and Dashboard steps come from the selected Workflow. |
| A prompt can claim that a Skill or document was used. | Current-visit Skill, document digest, read, review, and transition receipts are checked. |
| Every task is forced through one heavyweight process. | Discussion, simple, default, free, and custom execution have different, explicit outcomes. |
| “Supported” can hide host limitations. | Adapters publish A/B/C fidelity for context injection, veto, and Skill tracking. |

## Choose the right execution path

| Path | Intended use | Shape | Document behavior |
| --- | --- | --- | --- |
| Discussion | Questions, explanation, system notices, slash commands | No Change | No governed documents |
| Simple | Explicitly bounded, low-risk edits that match the allowlist and no exclusion | `change → verify → done` or `escalated` | No default OpenSpec contract |
| Default | Product, frontend, backend, research, fixes, features, and refactors | `open → explore → spec ⇄ build ⇄ verify → ship → archive` | Full default evidence chain |
| Free Track | Explicit neutral implementation without PM/frontend/backend overlays | The selected Workflow | The selected Workflow's gates and document contract still apply |
| Custom Workflow | A project-specific declarative process | Exactly its authored graph | Only its declared document contract; no contract means no document governance |

Simple routing is intentionally narrow. API or public-contract changes, schemas
and migrations, authentication or security, dependencies, releases, production
data, cross-module work, and new features are excluded even when the diff might
be one line.

[Understand routing and workflows →](docs/usage/routing-and-workflows.md)

## Dashboard at a glance

| Workflow progress | Workflow |
| --- | --- |
| <img src="docs-site/public/images/dashboard-progress.webp" alt="Tenon Dashboard workflow progress" width="1280" height="720" loading="lazy"> | <img src="docs-site/public/images/dashboard-workflow-editor.webp" alt="Tenon Dashboard workflow settings" width="1280" height="720" loading="lazy"> |
| Todo, phases, gates, and execution source stay aligned. | The workflow editor shows Tracks, phases, and pre-run facts. |

| Workbench settings |
| --- |
| <img src="docs-site/public/images/dashboard-workbench.webp" alt="Tenon Dashboard workflow workbench" width="1280" height="720" loading="lazy"> |
| Default, custom, and free modes share one inspectable orchestration model. |

The primary shell keeps only Workflow progress and Workflow as high-frequency
destinations. Theme and language live in the settings menu. Host Plan, AFK, and
machine diagnostics remain available through the CLI and local API; read-only
previews never execute commands.

[Read the complete Dashboard guide →](docs/usage/dashboard-and-local-api.md)

## Install

### Requirements

- Node.js 22 or later
- Git
- one selected host CLI
- Docker only when you want AFK container execution

New users do not need to clone the repository. Install the complete Codex
plugin in one command:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.5/install.sh | /bin/bash -s -- --codex
```

For Claude Code, change only the host flag:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.5/install.sh | /bin/bash -s -- --claude
```

The command installs prebuilt assets from the immutable stable `v0.1.5` release;
it does not clone or compile the source tree. The bootstrap registers the Tenon Marketplace, installs and verifies the same
complete release payload, and runs `tenon setup --<host>`. After installation,
use `tenon setup --codex`, `tenon update --codex`, and
`tenon runtime status` for lifecycle operations.

Installation starts the Dashboard and waits for readiness. A curl or CI install
does not open a browser; it prints the verified URL and `tenon dashboard --open`.
An interactive first setup may open it, while manual and background updates do not.

Enable the opt-in daily release check with:

```bash
tenon setup --codex --auto-update
```

Marketplace is the currently public one-command install. A thin npx package is
part of the release pipeline, but its exact package name is documented only
after an owned npm scope is actually published. Existing retired-identity
installations migrate through a separate migration-only repository; the Tenon
product has no old command alias.

After Codex setup, open Codex, run `/hooks`, and trust `tenon` once.
Then start a new host session so its packaged hooks and Skills are loaded.

```bash
tenon runtime status
tenon doctor
tenon dashboard --open
```

The production Dashboard is a single local SPA and API at
`http://127.0.0.1:18765/`. A separate Vite port is used only for frontend
development.

[Installation, all hosts, and lifecycle →](docs/usage/installation.md)

## First governed task

After setup and hook trust, ask for real work in normal conversation:

```text
Add keyboard navigation to the project switcher and test it.
```

The router either suppresses governance for discussion, selects the narrow
simple path, or creates a new governed Change on an applicable Track. It does
not silently resume an unrelated old Change.

Inspect the result:

```bash
tenon list --json
tenon status <change-name> --json
tenon document status <change-name>
tenon dashboard --open
```

To resume a known Change, identify it explicitly in the conversation or activate
it:

```bash
tenon session activate <change-name>
```

[Complete five-minute tutorial →](docs/usage/quickstart.md)

## How the default workflow earns progress

```text
open → explore → spec ⇄ build ⇄ verify → ship → archive
          review   review         review
                     ↑               │
                     └ requirements  └ verification failure → build
                       changed
```

The default workflow governs:

- Open: proposal, OpenSpec design, and tasks
- Explore: Superpowers design and ADR
- Spec: delta specification and implementation plans
- Verify: verification report
- Ship: applied specification

Later phases record current read receipts for the documents they consume.
Documents are authored by the active agent through the required phase Skills;
initializing state alone does not generate meaningful content. The ledger binds
each governed file to its digest, producer evidence, Change, phase visit, and
later reads.

Review exits are bound to an exact transition event:

```bash
tenon review request <change-name> --event <event>
tenon review acknowledge <change-name>
tenon transition <change-name> <event>
```

Continuous delegation can be recorded, but it does not waive documents, Skills,
guards, review evidence, security boundaries, publication authority, cost, or
external side effects.

[Default workflow →](docs/usage/default-workflow.md) ·
[Documents, Skills, and evidence →](docs/usage/documents-skills-and-evidence.md)

## Host adapter fidelity

Tenon exposes 12 host targets, with explicit enforcement fidelity:

| Tier | Hosts | Meaning |
| --- | --- | --- |
| A | Claude Code, Codex, Gemini CLI, Continue CLI, Cline, Amp | Native equivalents for injection, veto, and tracking |
| B | Cursor, GitHub Copilot coding agent, Pi, Aider | One or more capabilities use an honest degraded or later enforcement point |
| C | Devin, Zed | Static guidance plus manual CLI receipts; no native hard enforcement hook |

Important boundaries:

- Codex requires one-time local hook trust.
- Continue support means Continue CLI, not the IDE extension.
- Pi veto is advisory; Aider veto occurs at commit rather than write time.
- Amp is Tier A by adapter capability, but its payload details have not been
  validated in a credentialed end-to-end Amp session.

[Full host matrix →](docs/usage/installation.md#host-fidelity)

## Product surfaces

| Surface | What it owns |
| --- | --- |
| CLI | Setup, runtime lifecycle, Change state, transitions, review, evidence, Tracks, automation, and diagnostics |
| Kernel | Workflow/Track compilation, state, guards, ledgers, locking, CAS, and loop policy |
| Hooks and adapters | Context injection, pre-tool veto, Skill tracking, and host-specific installation |
| Dashboard | Projects, workflow progress, AFK, configuration, and machine diagnostics on one loopback server |
| AFK and loops | Optional sandboxed work, admission, budgets, concurrency, and L1/L2/L3 graduation |
| Channel | Advanced event-sourced worker communication; it does not mutate canonical Tenon state |
| Memory bridge | Read-only local session discovery and context extraction |
| Tap | Explicit opt-in local traffic diagnostics; captured prompts, headers, and tokens are sensitive |

## Documentation

- [Usage index](docs/usage/README.md)
- [Installation and host selection](docs/usage/installation.md)
- [Quickstart](docs/usage/quickstart.md)
- [Routing and workflows](docs/usage/routing-and-workflows.md)
- [Default workflow and reviews](docs/usage/default-workflow.md)
- [Custom Workflows and Tracks](docs/usage/custom-workflows-and-tracks.md)
- [Documents, Skills, and evidence](docs/usage/documents-skills-and-evidence.md)
- [Dashboard and local API](docs/usage/dashboard-and-local-api.md)
- [AFK and loop governance](docs/usage/automation-and-loops.md)
- [Advanced tools](docs/usage/advanced-tools.md)
- [Updates, recovery, and uninstall](docs/usage/updates-recovery-and-uninstall.md)
- [Troubleshooting](docs/usage/troubleshooting.md)
- [Security model](docs/usage/security-model.md)
- [CLI reference](docs/usage/cli-reference.md)
- [Contributor development](docs/usage/contributor-development.md)

## Local security boundary

The Dashboard binds to loopback, validates local Host headers, uses a random
handshake token for mutations, bounds JSON request bodies, and constrains file
operations to registered project roots. Managed releases are content-addressed
and revalidated before activation.

This is a local, single-user workstation model. It is not a remote multi-tenant
control plane and does not claim protection from every malicious process running
as the same OS user. Tap interception is off by default.

CI, the read-only pre-tag candidate, and release packaging all run
`npm run check:dependencies`, which combines the High/Critical advisory audit
with `npm ls --all`. A formal release also requires successful canonical push
CI for the exact current `main` SHA. The candidate accepts a new tag, or the
same tag when it already peels to that SHA for interrupted-release recovery,
and publishes a digest-normalized payload plus bounded approval evidence. A
default-branch-owned `workflow_run` writer revalidates the repository,
workflow, run, artifact, and approved SHA; current `main` must still match
before a new tag is created, while a matching existing tag may continue
recovery. This minimal writer checks out and executes no repository code.
Packaging must prove the peeled tag commit equals that approved SHA.

[Security model →](docs/usage/security-model.md) ·
[Report a vulnerability privately →](SECURITY.md)

## Develop from source

The repository is an npm workspace and is not advertised as a published global
npm CLI.

```bash
git clone https://github.com/jefferysha/tenon.git
cd tenon
npm ci
npm run build
npm test
npm run test:web
bash tools/test-hooks.sh
bash tools/test-adapters.sh
bash tools/verify-skills.sh
bash tools/test-bundle.sh
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing contracts, generated
assets, adapters, hooks, or distribution files.

## Project status and community

Starting with Tenon 1.0, user-facing plugin manifests, workspace packages, Git
tags, and the optional npx package use one release version. Documentation
describes behavior verified for the current release; the local Dashboard is not
a hosted service and carries no remote-service SLA.

- Questions and non-sensitive problems: [Support](SUPPORT.md)
- Patches and design changes: [Contributing](CONTRIBUTING.md)
- Community expectations: [Code of Conduct](CODE_OF_CONDUCT.md)
- Vulnerabilities: [Security policy](SECURITY.md)
- License: [MIT](LICENSE)
