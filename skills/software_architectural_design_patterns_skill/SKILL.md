---
name: software-architectural-design-patterns
description: Use this skill when designing, refactoring, or reviewing codebase architecture and you need to choose, combine, or critique classic software design patterns across Creator/Creational, Structural, and Behavioral categories. The skill helps a coding agent produce practical design decisions, interfaces, module boundaries, implementation plans, trade-offs, and tests without pattern cargo-culting.
---

# Software Architectural Design Patterns Skill

This skill turns the classic 22 design-pattern catalog into coding-agent instructions for architecture design. It covers:

- **Creator / Creational patterns**: object creation and lifecycle.
- **Structural patterns**: object/class composition and interface boundaries.
- **Behavioral patterns**: collaboration, algorithms, workflows, and responsibility assignment.

The skill follows a 22-pattern catalog: 5 creator/creational, 7 structural, and 10 behavioral. The original Gang of Four catalog has 23 patterns; this skill intentionally excludes **Interpreter** by default because the requested source structure and the Refactoring.Guru-style 22-pattern catalog exclude it. Add Interpreter only when designing a grammar, DSL, parser, or expression evaluator.

## Non-negotiables for the coding agent

1. **Do not force a pattern.** Use a pattern only when it removes coupling, isolates variability, clarifies lifecycle, simplifies collaboration, or improves testability.
2. **Identify the design force first.** State what is varying: object type, object family, construction steps, interface mismatch, hierarchy, behavior, state, traversal, operation set, or event flow.
3. **Prefer language/framework idioms when simpler.** Modern functions, interfaces, dependency injection, closures, protocols, enums, pattern matching, async streams, and framework middleware may eliminate the need for a class-heavy pattern.
4. **Prefer composition over inheritance unless inheritance is the point.** Template Method and Factory Method can use inheritance, but many designs are cleaner with Strategy, injection, or small functions.
5. **Make dependencies explicit.** Avoid hidden globals, service locators, and pattern names that mask unclear ownership.
6. **Produce tests with the architecture.** Every pattern proposal must include contract tests, substitution tests, integration boundaries, and failure-mode tests where relevant.
7. **Use pattern names as team vocabulary, not decoration.** Name classes after roles only when it improves clarity.

## Invocation triggers

Use this skill when the user or task asks to:

- design or refactor codebase architecture;
- reduce coupling between modules/classes/services;
- select among Behavioral, Creator/Creational, or Structural design patterns;
- design plugin systems, adapters, factories, workflows, state machines, middleware, event flows, undo/redo, object hierarchies, or cross-cutting wrappers;
- review an implementation for design-pattern fit or overengineering.

## Required workflow

When invoked, follow this sequence:

### 1. Frame the design problem

Capture:

- domain/use case;
- modules/classes involved;
- what changes often vs rarely;
- runtime vs compile-time variation;
- ownership/lifecycle of objects;
- sync/async/concurrency constraints;
- persistence, transaction, and failure boundaries;
- testing needs.

### 2. Classify the design pressure

Use the smallest matching bucket:

- **Creation/lifecycle pressure** → Creator / Creational.
- **Composition/interface pressure** → Structural.
- **Collaboration/workflow/algorithm pressure** → Behavioral.

### 3. Select candidate patterns

Shortlist 1–3 patterns. For each candidate, state:

- why it fits;
- what it would replace;
- what trade-off it introduces;
- when it would be overkill.

### 4. Produce a Pattern Decision Record

Always output this structure:

```markdown
## Pattern Decision Record

Problem:
Forces:
Chosen pattern(s):
Rejected alternatives:
Why this pattern:
Roles/interfaces:
Module placement:
Lifecycle/ownership:
Data and error flow:
Concurrency/transaction notes:
Migration steps:
Testing plan:
Risks and guardrails:
```

### 5. Produce an implementation sketch

Provide concrete names for interfaces/classes/modules, but keep implementation language idiomatic. Include:

- interfaces/protocols;
- concrete implementations;
- composition root/wiring;
- boundary adapters;
- example call flow;
- tests.

## Pattern selection map

### Creator / Creational: object creation and lifecycle

| Problem signal | Prefer |
|---|---|
| Product type is unknown, pluggable, or environment-specific | Factory Method |
| Families of related products must remain compatible | Abstract Factory |
| Construction is multi-step, validated, or has many optional parts | Builder |
| Runtime-configured objects should be copied cheaply | Prototype |
| Exactly one process-wide instance is required for correctness | Singleton |

### Structural: object/class composition and boundaries

| Problem signal | Prefer |
|---|---|
| Client expects one interface but dependency exposes another | Adapter |
| Two dimensions vary independently and inheritance explodes combinations | Bridge |
| Tree/part-whole structure should be treated uniformly | Composite |
| Add optional stackable responsibilities around an object | Decorator |
| Hide subsystem complexity behind a stable API | Facade |
| Many similar objects duplicate immutable state and cause memory pressure | Flyweight |
| Control access, lazy loading, remote access, caching, or protection | Proxy |

### Behavioral: collaboration, algorithms, and responsibility

| Problem signal | Prefer |
|---|---|
| Request passes through ordered or dynamic handlers | Chain of Responsibility |
| Action needs to be queued, logged, retried, scheduled, or undone | Command |
| Traverse a collection without exposing internals | Iterator |
| Many components are tightly interdependent | Mediator |
| Need undo/checkpoint snapshots without exposing internals | Memento |
| Publish changes to unknown/dynamic subscribers | Observer |
| Behavior changes by object state with clear transitions | State |
| Swap algorithms/policies at runtime | Strategy |
| Algorithm skeleton is fixed; steps vary | Template Method |
| Add operations over a stable object structure | Visitor |

## Fast distinction guide

- **Factory Method vs Abstract Factory**: Factory Method creates one product family member through overridable/provider creation. Abstract Factory creates a whole compatible family.
- **Builder vs Factory**: Builder manages construction steps and invariants. Factory selects product type.
- **Strategy vs State**: Strategy changes an algorithm chosen by the client/config. State changes behavior because the context's internal lifecycle state changed.
- **Decorator vs Proxy**: Decorator adds responsibilities. Proxy controls access or indirection.
- **Adapter vs Facade**: Adapter changes an interface. Facade simplifies a subsystem.
- **Mediator vs Observer**: Mediator coordinates known colleagues. Observer broadcasts events to subscribers without knowing them.
- **Composite vs Visitor**: Composite models a tree uniformly. Visitor adds operations across a stable tree/type hierarchy.
- **Command vs Strategy**: Command represents an action/request with lifecycle. Strategy represents an interchangeable algorithm/policy.
- **Chain of Responsibility vs Decorator**: Chain routes a request through possible handlers. Decorator wraps one object to add behavior around calls.
- **Template Method vs Strategy**: Template Method varies steps through inheritance. Strategy varies behavior through composition.

## Pattern catalog

See `PATTERN_CATALOG.md` for full cards. Compact index:


### Creator / Creational

- **Factory Method** — Provide a common creation interface while allowing subclasses, plugins, or providers to decide the concrete product type.
- **Abstract Factory** — Create families of related or compatible objects without binding clients to their concrete classes.
- **Builder** — Construct complex objects step by step while keeping construction rules separate from the final representation.
- **Prototype** — Create new objects by cloning preconfigured prototypes instead of coupling clients to concrete classes or expensive setup.
- **Singleton** — Ensure exactly one instance of a class exists and provide controlled access to it.

### Structural

- **Adapter** — Translate one interface into another expected by the client.
- **Bridge** — Separate an abstraction from its implementation so both can evolve independently.
- **Composite** — Represent part-whole hierarchies so clients can treat individual objects and groups uniformly.
- **Decorator** — Add responsibilities to an object dynamically by wrapping it with objects that share the same interface.
- **Facade** — Provide a simple, stable entry point over a complex subsystem.
- **Flyweight** — Reduce memory use by sharing immutable intrinsic state across many similar objects while keeping extrinsic/context state outside.
- **Proxy** — Provide a surrogate object that controls access to another object while preserving its interface.

### Behavioral

- **Chain of Responsibility** — Pass a request along a chain of handlers until one handles it or all pass.
- **Command** — Encapsulate an action request as an object so it can be queued, logged, retried, authorized, scheduled, undone, or composed.
- **Iterator** — Provide sequential access to elements of a collection without exposing its internal representation.
- **Mediator** — Centralize communication among many components so they depend on a mediator instead of each other.
- **Memento** — Capture and restore an object’s internal state without exposing that internal structure.
- **Observer** — Notify dependent subscribers when a subject changes without hard-coupling the subject to concrete observers.
- **State** — Let an object alter behavior when its internal state changes by delegating behavior to state objects.
- **Strategy** — Encapsulate interchangeable algorithms or policies behind a common interface and select one at runtime.
- **Template Method** — Define the skeleton of an algorithm in a base class while letting subclasses override specific steps.
- **Visitor** — Add operations over a stable object structure without modifying the element classes each time.

## Codebase placement rules

- Put **domain interfaces** near the consumer/domain layer when they express business needs.
- Put **adapters, proxies, and concrete factories** near infrastructure boundaries.
- Put **composition/wiring** in the composition root, dependency-injection container, app bootstrap, or module assembly layer.
- Keep **domain entities** free of infrastructure dependencies.
- Keep **pattern plumbing private** where possible; expose stable domain/application APIs.
- Prefer package/module boundaries that match ownership and change frequency, not pattern categories.

## Testing requirements by category

- **Creator / Creational**: product contract tests, factory selection tests, construction invariant tests, lifecycle/thread-safety tests.
- **Structural**: interface substitution tests, mapping/wrapping tests, boundary integration tests, composition-order tests.
- **Behavioral**: workflow/order tests, transition tests, event delivery tests, idempotency/retry tests, failure propagation tests.

## Red flags

- Pattern names appear before the problem is described.
- A pattern adds more public classes than the problem needs.
- The design hides dependencies instead of making them explicit.
- A Singleton is used because dependency injection feels inconvenient.
- Observer/Event Bus is used where direct calls would be clearer and safer.
- Factory classes only call constructors without policy, abstraction, or lifecycle value.
- A Facade becomes a dumping ground for unrelated operations.
- Decorator/Proxy stacks hide latency, ordering, authorization, or error behavior.
- State/Strategy objects require unsafe access to all context internals.
- Visitor forces every small model change to touch many files.

## Deliverable standard

The coding agent should finish with:

1. a Pattern Decision Record;
2. interface/module sketch;
3. migration plan from current code if relevant;
4. tests;
5. risks;
6. one simpler alternative and why it was rejected or accepted.
