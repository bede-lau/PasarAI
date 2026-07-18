# Agent Handoff Prompt

Use this prompt when handing the skill to a coding agent.

```text
You have access to the Software Architectural Design Patterns skill.

When designing or refactoring architecture, do not start by naming a pattern. First identify the design pressure: creation/lifecycle, structural composition/interface boundary, or behavioral collaboration/workflow.

Then shortlist 1–3 patterns from the 22-pattern catalog and produce a Pattern Decision Record with chosen pattern(s), rejected alternatives, roles/interfaces, module placement, lifecycle/ownership, data/error flow, migration steps, tests, and risks.

Use the smallest pattern that solves the problem. Prefer language/framework idioms and dependency injection over ceremony. Make dependencies explicit. Avoid global mutable state. Provide interface/module sketches and testing strategy.
```
