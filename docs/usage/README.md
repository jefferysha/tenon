# Tenon usage guide

This manual is the canonical task-oriented guide for the current repository
behavior. Start with installation and quickstart, then open the guide that
matches the operation you need.

## Start here

1. [Install and select one host](installation.md)
2. [Run the first governed task](quickstart.md)
3. [Choose discussion, simple, default, free, or custom](routing-and-workflows.md)
4. [Understand the default workflow and review gates](default-workflow.md)
5. [Understand documents, Skills, and evidence](documents-skills-and-evidence.md)
6. [Author and use agents](agents.md)

## Author and operate

- [Custom Workflows and Tracks](custom-workflows-and-tracks.md)
- [Dashboard and local API](dashboard-and-local-api.md)
- [AFK and loop governance](automation-and-loops.md)
- [Advanced Channel, memory, and Tap tools](advanced-tools.md)
- [Updates, recovery, and uninstall](updates-recovery-and-uninstall.md)
- [Troubleshooting](troubleshooting.md)
- [Security model](security-model.md)
- [CI verification and evidence export](ci-verification.md)
- [CLI reference](cli-reference.md)

## Contribute

- [Contributor development](contributor-development.md)
- [Repository contribution guide](../../CONTRIBUTING.md)
- [Security policy](../../SECURITY.md)
- [Support](../../SUPPORT.md)
- [Code of Conduct](../../CODE_OF_CONDUCT.md)

## Product boundaries

- Tenon is a local plugin and workstation service, not a hosted SaaS.
- Setup and update always target exactly one host.
- A discussion creates no Change.
- The packaged simple Workflow does not use the default OpenSpec contract.
- Free removes domain overlays; it does not bypass the selected Workflow.
- Short/custom Workflows govern only the documents they declare.
- The 12 host adapters have different fidelity tiers.
- AFK, Tap interception, and unattended loop execution are optional and
  explicitly controlled.
- The repository is not advertised as a published global npm CLI.

Return to the [English README](../../README.md) or
[Chinese README](../../README.zh-CN.md).

