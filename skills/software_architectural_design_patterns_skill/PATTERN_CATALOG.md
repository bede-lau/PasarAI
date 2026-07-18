# Pattern Catalog: 22 Software Architectural Design Patterns

This catalog is written for a coding agent. Each card tells the agent when to use a pattern, when not to use it, how to implement it, and what to test.


## Creator / Creational

### Factory Method

**Intent:** Provide a common creation interface while allowing subclasses, plugins, or providers to decide the concrete product type.

**Use when:**
- Client code should depend on a product interface, not concrete classes.
- The exact product type depends on runtime config, environment, feature flag, tenant, plugin, or framework extension.
- Creation logic is duplicated or spreading conditionals across the codebase.

**Avoid when:**
- A direct constructor is clear and unlikely to vary.
- The factory only wraps `new` without reducing coupling or centralizing policy.
- You would need a subclass explosion for tiny variations.

**Implementation recipe:**
- Define a `Product` interface/abstract type for all created objects.
- Put orchestration/common behavior in a `Creator` or service that calls a factory method.
- Implement concrete creators/providers for each product variant.
- Inject or select the creator at the composition root; keep consumers on product interfaces.

**Architecture examples:** cross-platform UI widgets, storage provider clients, payment processor implementations, exporter/importer plugins.

**Testing focus:**
- contract tests for every Product
- factory selection tests for config/environment
- consumer tests against Product interface

### Abstract Factory

**Intent:** Create families of related or compatible objects without binding clients to their concrete classes.

**Use when:**
- Several products must be used together as a compatible family.
- The whole family varies by platform, vendor, theme, tenant, cloud provider, or protocol.
- You need to swap a complete implementation set behind stable interfaces.

**Avoid when:**
- There is only one product type; Factory Method may be enough.
- The product family changes shape frequently, because every new product method changes all factories.
- Compatibility rules are better expressed as data/config than class families.

**Implementation recipe:**
- Define an abstract factory interface with one creation method per product in the family.
- Define product interfaces for each product role.
- Implement one concrete factory per family/variant.
- Inject the factory into application services; do not let consumers instantiate concrete products.

**Architecture examples:** AWS/GCP/Azure infrastructure adapters, SQL dialect components, theme-specific UI components, hardware-driver families.

**Testing focus:**
- factory compatibility tests
- product family integration tests
- cross-family contract tests

### Builder

**Intent:** Construct complex objects step by step while keeping construction rules separate from the final representation.

**Use when:**
- Constructors have many optional parameters or mutually dependent fields.
- Construction requires validation, ordering, defaults, nested objects, or multi-step assembly.
- The same construction process can produce different representations.

**Avoid when:**
- A small immutable value object or named parameters are simpler.
- The builder lets callers bypass invariants.
- The builder mirrors every setter and adds ceremony without enforcing rules.

**Implementation recipe:**
- Put required fields in the constructor or required builder steps.
- Expose fluent or staged methods for optional parts.
- Validate invariants in `build()` and return an immutable result where possible.
- Use a Director only when multiple repeatable build recipes exist.

**Architecture examples:** query builders, HTTP request/client configuration, workflow/job definitions, test data factories.

**Testing focus:**
- valid construction paths
- invalid state validation
- defaulting behavior
- immutability/defensive copy checks

### Prototype

**Intent:** Create new objects by cloning preconfigured prototypes instead of coupling clients to concrete classes or expensive setup.

**Use when:**
- Objects are expensive to initialize but cheap to copy.
- Variants are configured at runtime and should be cloned on demand.
- The system should add new concrete types without changing creation code.

**Avoid when:**
- Object identity, ownership, file handles, network handles, or mutable nested state make cloning ambiguous.
- A factory with explicit parameters is clearer.
- The prototype graph requires fragile deep-copy logic.

**Implementation recipe:**
- Define a clone/copy interface or copy constructor.
- Choose shallow versus deep copy deliberately; document ownership of mutable fields.
- Register named prototypes in a registry/factory.
- Let clients request a named prototype and customize the clone, not the original.

**Architecture examples:** document templates, game entities, ML pipeline config variants, preconfigured workflow tasks.

**Testing focus:**
- clone independence tests
- deep copy tests for mutable fields
- registry lookup tests

### Singleton

**Intent:** Ensure exactly one instance of a class exists and provide controlled access to it.

**Use when:**
- There is truly one process-wide resource/coordinator with unique identity.
- Multiple instances would violate correctness, not merely convenience.
- The instance is stateless or its state is carefully synchronized.

**Avoid when:**
- You only want easy access; prefer dependency injection.
- The object holds mutable global state that makes tests order-dependent.
- The singleton hides dependencies or becomes a service locator.

**Implementation recipe:**
- Make construction private or framework-controlled.
- Use thread-safe lazy/eager initialization appropriate to the runtime.
- Expose an interface and inject it where possible.
- Provide explicit reset/test hooks only in test infrastructure, not production APIs.

**Architecture examples:** process metrics registry, feature flag snapshot provider, application configuration holder, shared scheduler.

**Testing focus:**
- thread-safety tests if lazy
- state isolation tests
- dependency-injection tests to avoid hidden globals


## Structural

### Adapter

**Intent:** Translate one interface into another expected by the client.

**Use when:**
- A third-party, legacy, or external API is useful but has an incompatible interface.
- You need to protect domain/application code from vendor-specific types.
- You are migrating systems and need a compatibility layer.

**Avoid when:**
- You control both sides and can simply change the interface.
- The adapter starts adding business policy; that belongs in application/domain services.
- You create many leaky adapters that still expose vendor concepts everywhere.

**Implementation recipe:**
- Define the target interface in the consuming layer.
- Wrap the adaptee and translate calls, data shapes, errors, and units.
- Keep mapping code near infrastructure boundaries.
- Add anti-corruption mapping for external domain models.

**Architecture examples:** payment gateway adapter, legacy database adapter, cloud SDK adapter, external API client wrapper.

**Testing focus:**
- adapter mapping tests
- error translation tests
- contract tests against target interface
- integration tests with real/stubbed vendor

### Bridge

**Intent:** Separate an abstraction from its implementation so both can evolve independently.

**Use when:**
- Two dimensions vary independently and inheritance would create a combinatorial class explosion.
- You need runtime swapping of implementation behind a stable abstraction.
- You want high-level policy separated from platform/vendor/mechanism.

**Avoid when:**
- There is only one implementation dimension.
- A simple strategy injection is enough and the abstraction hierarchy adds no value.
- The split hides important behavior behind vague names.

**Implementation recipe:**
- Identify the stable abstraction API and the implementation API.
- Store an implementation interface inside the abstraction.
- Create refined abstractions and concrete implementations independently.
- Inject implementations at composition boundaries.

**Architecture examples:** notification type vs delivery channel, shape renderer vs drawing backend, report abstraction vs output engine, storage service vs provider.

**Testing focus:**
- abstraction tests with fake implementors
- implementor contract tests
- matrix tests for key abstraction/implementation combinations

### Composite

**Intent:** Represent part-whole hierarchies so clients can treat individual objects and groups uniformly.

**Use when:**
- The domain naturally forms a tree or hierarchy.
- Clients should run the same operation on leaves and groups.
- Recursive traversal logic is duplicated across callers.

**Avoid when:**
- The hierarchy is shallow and a collection is clearer.
- Leaf and container operations differ so much that a common interface becomes dishonest.
- Parent-child ownership/cycle rules are not well defined.

**Implementation recipe:**
- Define a common Component interface.
- Implement Leaf objects with no children.
- Implement Composite objects that store child Components and delegate/aggregate behavior recursively.
- Enforce acyclic ownership and clear traversal semantics.

**Architecture examples:** menu trees, file/folder models, organization charts, workflow step groups, UI component trees.

**Testing focus:**
- leaf behavior tests
- recursive aggregation tests
- cycle/ownership validation
- empty composite behavior

### Decorator

**Intent:** Add responsibilities to an object dynamically by wrapping it with objects that share the same interface.

**Use when:**
- You need optional or stackable behavior without subclass explosion.
- Behavior should be added per instance, not globally.
- Cross-cutting behavior should remain composable and testable.

**Avoid when:**
- Call order matters but is not controlled or documented.
- A wrapper changes the public contract unexpectedly.
- Debugging wrapper stacks would be harder than explicit composition.

**Implementation recipe:**
- Define a component interface.
- Create a base/wrapper decorator that holds another component.
- Implement concrete decorators that call the wrapped component before/after/around added behavior.
- Assemble decorator order at the composition root.

**Architecture examples:** caching around repositories, retry/logging/metrics around clients, compression/encryption streams, authorization guards.

**Testing focus:**
- decorator pass-through tests
- behavior ordering tests
- composition tests with multiple decorators

### Facade

**Intent:** Provide a simple, stable entry point over a complex subsystem.

**Use when:**
- Clients must coordinate many subsystem classes for a common use case.
- You want to reduce coupling to internal subsystem details.
- You need a clean API for a module, package, or bounded context.

**Avoid when:**
- The facade becomes a god object containing business logic from multiple domains.
- It hides necessary configuration/error handling.
- It duplicates every subsystem method one-to-one without simplifying.

**Implementation recipe:**
- Identify high-value use cases clients actually need.
- Expose coarse-grained methods that orchestrate subsystem classes.
- Keep subsystem objects replaceable/injectable.
- Let advanced clients bypass the facade only through deliberate internal APIs.

**Architecture examples:** checkout service API, reporting module facade, ML training pipeline facade, file conversion facade.

**Testing focus:**
- facade orchestration tests
- subsystem integration tests
- backward compatibility tests for public facade API

### Flyweight

**Intent:** Reduce memory use by sharing immutable intrinsic state across many similar objects while keeping extrinsic/context state outside.

**Use when:**
- The app creates huge numbers of similar objects.
- Repeated immutable state dominates memory usage.
- Object identity is less important than compact representation.

**Avoid when:**
- You have not measured a memory problem.
- Shared state must be mutable per instance.
- CPU or lookup overhead would cost more than saved memory.

**Implementation recipe:**
- Split intrinsic state from extrinsic state.
- Make flyweight objects immutable.
- Use a factory/cache to reuse flyweights by intrinsic-state key.
- Store context/extrinsic state in callers or lightweight context objects.

**Architecture examples:** text glyphs, game particles, map tiles, permission/role descriptors, deduplicated metadata.

**Testing focus:**
- memory/regression benchmarks
- cache key equality tests
- immutability tests
- context rendering/behavior tests

### Proxy

**Intent:** Provide a surrogate object that controls access to another object while preserving its interface.

**Use when:**
- You need lazy loading, access control, caching, remote access, rate limiting, or instrumentation.
- Clients should interact with the same interface whether the real subject is local, remote, cached, or protected.
- Expensive object creation or remote calls need controlled timing.

**Avoid when:**
- A decorator better expresses added behavior and no access control/lazy/remote indirection is needed.
- The proxy hides latency, failure, or security boundaries from callers that must handle them.
- The proxy breaks identity/equality assumptions.

**Implementation recipe:**
- Define a Subject interface implemented by both real subject and proxy.
- Let the proxy hold or lazily create the real subject.
- Add access/check/cache/remote/metrics behavior around calls.
- Expose latency and error semantics in the interface or documentation.

**Architecture examples:** virtual image/document loader, remote service client, authorization proxy, repository cache proxy, RPC stub.

**Testing focus:**
- lazy initialization tests
- access-control tests
- cache behavior tests
- remote failure propagation tests


## Behavioral

### Chain of Responsibility

**Intent:** Pass a request along a chain of handlers until one handles it or all pass.

**Use when:**
- Multiple handlers may process a request and the handler set/order can change.
- Sender should not know which handler will act.
- You need pipelines for validation, middleware, authorization, routing, or fallback.

**Avoid when:**
- Exactly one known receiver should always handle the request.
- Silent fall-through would hide errors.
- Handlers need complex coordination or shared mutable context that becomes hard to reason about.

**Implementation recipe:**
- Define a Handler interface with `handle(request, next)` or a linked successor.
- Make each handler either handle, transform, stop, or pass on clearly.
- Define terminal behavior for unhandled requests.
- Assemble order explicitly in one place.

**Architecture examples:** HTTP middleware, validation pipelines, authentication/authorization flows, support ticket routing, event fallback.

**Testing focus:**
- handler order tests
- short-circuit tests
- unhandled request tests
- per-handler unit tests

### Command

**Intent:** Encapsulate an action request as an object so it can be queued, logged, retried, authorized, scheduled, undone, or composed.

**Use when:**
- You need undo/redo, task queues, job scheduling, audit logs, or retries.
- Invoker should not know the receiver’s concrete method.
- Actions need metadata, validation, authorization, or serialization.

**Avoid when:**
- A direct method call is enough.
- Command classes simply mirror every service method without adding lifecycle/value.
- Commands capture unstable live object references that cannot be serialized/replayed safely.

**Implementation recipe:**
- Define a Command interface such as `execute()` and optionally `undo()`.
- Put all required action parameters into the command object.
- Keep receivers/services explicit dependencies.
- Use command handlers for validation, transactions, retries, and authorization when appropriate.

**Architecture examples:** background jobs, CQRS command handlers, editor undo/redo, workflow tasks, CLI/API actions.

**Testing focus:**
- execute side effects
- undo idempotence
- serialization/retry behavior
- authorization/validation tests

### Iterator

**Intent:** Provide sequential access to elements of a collection without exposing its internal representation.

**Use when:**
- Clients need traversal but not collection internals.
- You have multiple traversal strategies or lazy/paginated traversal.
- The collection representation may change.

**Avoid when:**
- The language already provides safe idiomatic iteration and no custom traversal is needed.
- The iterator exposes internal mutation hazards.
- Parallel/concurrent modification semantics are unclear.

**Implementation recipe:**
- Define iterator methods or use language iterator protocols.
- Keep traversal state in the iterator, not the collection.
- Support filtering/lazy/paginated traversal deliberately.
- Define behavior for mutation during iteration.

**Architecture examples:** paginated API readers, tree traversals, streaming result sets, filesystem traversal, cursor abstractions.

**Testing focus:**
- empty/single/multiple traversal
- end-of-iteration behavior
- mutation/concurrency rules
- lazy pagination tests

### Mediator

**Intent:** Centralize communication among many components so they depend on a mediator instead of each other.

**Use when:**
- Many objects communicate in a tangled many-to-many graph.
- Component reuse is blocked by direct references to peers.
- Workflow coordination belongs outside individual components.

**Avoid when:**
- The mediator becomes a god object with all business rules.
- A simple event bus/observer is enough and no central coordination is needed.
- Component interactions are naturally direct and few.

**Implementation recipe:**
- Define a mediator interface with specific coordination operations.
- Components notify mediator of events and expose narrow APIs.
- Move cross-component workflow to mediator/application service.
- Keep domain decisions in domain services/entities, not arbitrary UI mediators.

**Architecture examples:** UI form/dialog coordination, workflow orchestration, chat room coordination, module interaction hub, application service coordinating domain objects.

**Testing focus:**
- component isolation tests with fake mediator
- workflow coordination tests
- no direct peer dependency checks

### Memento

**Intent:** Capture and restore an object’s internal state without exposing that internal structure.

**Use when:**
- You need undo/redo, snapshots, checkpoints, or rollback.
- The originator should control its own internal state format.
- External code should store snapshots but not inspect or mutate them.

**Avoid when:**
- Snapshots are huge and performance/storage impact is unacceptable.
- External systems or databases require transactional consistency beyond a single object.
- State can be reconstructed more safely from events.

**Implementation recipe:**
- Let the Originator create opaque Mementos.
- Let a Caretaker store history but not inspect internals.
- Define retention limits, compression, or diff snapshots for large states.
- Restore only through Originator APIs.

**Architecture examples:** editor undo, workflow checkpoints, simulation snapshots, draft restoration, configuration rollback.

**Testing focus:**
- snapshot/restore equivalence
- history bounds
- immutability/opacity of memento
- large-state performance tests

### Observer

**Intent:** Notify dependent subscribers when a subject changes without hard-coupling the subject to concrete observers.

**Use when:**
- Many components react to state/domain events.
- Publishers should not know subscribers.
- Subscribers can be added/removed dynamically.

**Avoid when:**
- Event ordering, delivery guarantees, or transactional semantics are critical but unspecified.
- Synchronous observer chains create hidden latency or failures.
- Subscriptions can leak memory or create feedback loops.

**Implementation recipe:**
- Define event types and a subscription mechanism.
- Use weak subscriptions/unsubscribe lifecycle where relevant.
- Decide sync vs async delivery, ordering, retries, and failure handling.
- Keep events meaningful; avoid exposing internal mutable state.

**Architecture examples:** domain events, UI state updates, cache invalidation, notification dispatch, plugin hooks.

**Testing focus:**
- subscriber notification tests
- unsubscribe/lifecycle tests
- failure isolation tests
- event ordering/retry tests

### State

**Intent:** Let an object alter behavior when its internal state changes by delegating behavior to state objects.

**Use when:**
- Large conditionals switch behavior based on state.
- Valid transitions and per-state behavior are central to correctness.
- New states/transitions are expected.

**Avoid when:**
- There are only two simple states and conditionals are clearer.
- State objects need too much access to context internals.
- The transition table is better represented as data or a state machine library.

**Implementation recipe:**
- Define a State interface for operations that vary by state.
- Move state-specific behavior into concrete state classes.
- Let the Context delegate operations to current state.
- Centralize transition rules or make them explicit in state methods.

**Architecture examples:** order lifecycle, document publishing workflow, connection/session state, game character behavior, device controller.

**Testing focus:**
- per-state behavior
- valid/invalid transitions
- transition side effects
- state persistence/rehydration

### Strategy

**Intent:** Encapsulate interchangeable algorithms or policies behind a common interface and select one at runtime.

**Use when:**
- A family of algorithms/policies vary independently from the context.
- Conditionals choose among algorithms.
- You need tenant/user/config-driven behavior.

**Avoid when:**
- Algorithms differ only trivially and simple functions are clearer.
- Strategies require incompatible inputs/outputs; the interface is not actually common.
- Runtime switching would violate consistency or security.

**Implementation recipe:**
- Define a Strategy interface for the variable behavior.
- Implement concrete strategies with no context-specific side effects when possible.
- Inject/select a strategy at composition/runtime.
- Keep the Context responsible for orchestration and shared invariant checks.

**Architecture examples:** pricing/discount rules, payment methods, routing algorithms, sorting/searching policies, feature rollout policies.

**Testing focus:**
- contract tests for each strategy
- selection/config tests
- context invariant tests
- edge-case comparison tests

### Template Method

**Intent:** Define the skeleton of an algorithm in a base class while letting subclasses override specific steps.

**Use when:**
- Several classes share an algorithm structure but differ in certain steps.
- The sequence of steps must stay fixed.
- Common steps should be reused and variant steps isolated.

**Avoid when:**
- Composition/Strategy would be more flexible and testable.
- Subclasses need to change the algorithm order.
- Inheritance would expose too much base-class implementation detail.

**Implementation recipe:**
- Create an abstract base class with a final/non-overridable template method where possible.
- Break the algorithm into primitive operations and hooks.
- Provide default implementations for optional steps.
- Keep subclass responsibilities narrow and documented.

**Architecture examples:** data import/export pipelines, test framework lifecycle, report generation phases, game AI turn sequence.

**Testing focus:**
- template order tests
- subclass step behavior
- hook behavior
- LSP/substitution tests

### Visitor

**Intent:** Add operations over a stable object structure without modifying the element classes each time.

**Use when:**
- The object hierarchy is stable but new operations are frequent.
- Operations need type-specific behavior across many element classes.
- You want to separate algorithms from domain object structure.

**Avoid when:**
- The element hierarchy changes often, because every visitor must change.
- The visitor needs to violate encapsulation to do useful work.
- Pattern matching or multimethods in the language solve this more simply.

**Implementation recipe:**
- Define a Visitor interface with a visit method for each element type.
- Add `accept(visitor)` to each element that calls the correct visit method.
- Put each new operation in a concrete visitor.
- Keep element interfaces stable and avoid exposing unnecessary internals.

**Architecture examples:** AST operations, document/export transformations, validation/reporting over object trees, compiler passes, geometry calculations over shapes.

**Testing focus:**
- visitor coverage for every element type
- new operation tests
- encapsulation checks
- object-structure traversal tests

