# Pattern Decision Record Template

Use this template whenever applying the Software Architectural Design Patterns skill.

```markdown
## Pattern Decision Record

Problem:
- What codebase/design problem is being solved?

Forces:
- What changes often?
- What must remain stable?
- What dependencies are causing coupling?
- What lifecycle, performance, concurrency, or transaction constraints matter?

Chosen pattern(s):
- Pattern name(s) and category.

Rejected alternatives:
- Simpler direct implementation:
- Alternative pattern:
- Framework/language idiom:

Why this pattern:
- Coupling reduced:
- Variability isolated:
- Testability improved:
- Complexity added:

Roles/interfaces:
- Client:
- Interface/protocol:
- Concrete implementations:
- Composition/wiring:
- Boundary modules:

Module placement:
- Domain:
- Application:
- Infrastructure:
- API/UI:
- Tests:

Lifecycle/ownership:
- Who creates each object?
- Who owns each dependency?
- Singleton/global state avoided or justified?

Data and error flow:
- Inputs:
- Outputs:
- Errors/exceptions:
- Retries/timeouts:
- Observability:

Concurrency/transaction notes:
- Thread safety:
- Async behavior:
- Transaction boundary:
- Idempotency:

Migration steps:
1.
2.
3.

Testing plan:
- Unit:
- Contract:
- Integration:
- Regression:
- Failure-mode:

Risks and guardrails:
- Overengineering risk:
- Performance risk:
- Debuggability risk:
- Maintenance guardrail:
```
