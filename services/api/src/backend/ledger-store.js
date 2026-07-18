import { sumDecimal } from "@pasarai/finance";

function clone(value) {
  return structuredClone(value);
}

function effectiveDate(value) {
  return value?.slice(0, 10) ?? "0000-01-01";
}

function calendarDate(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return effectiveDate(value);
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export class InMemoryLedgerStore {
  #events = [];
  #eventsById = new Map();
  #eventsByExternalId = new Map();
  #idempotency = new Map();
  #productProfiles = new Map();
  #clarificationsBySourceEventId = new Map();
  #merchantTimeZones = new Map();
  #receiptReviewMutations = new Map();

  constructor({
    productProfiles = [],
    merchantTimeZones = {},
  } = {}) {
    for (const [merchantId, timeZone] of Object.entries(merchantTimeZones)) {
      this.#merchantTimeZones.set(merchantId, timeZone);
    }
    for (const profile of productProfiles) {
      if (profile.timeZone) {
        this.#merchantTimeZones.set(profile.merchantId, profile.timeZone);
      }
      const timeZone = this.#merchantTimeZones.get(profile.merchantId)
        ?? "Asia/Kuala_Lumpur";
      this.#productProfiles.set(profile.productId, {
        merchantId: profile.merchantId,
        productId: profile.productId,
        baselineUnitCogsRm: profile.baselineUnitCogsRm,
        targetGrossMarginPct: profile.targetGrossMarginPct ?? "40.00",
        snapshots: [{
          effectiveDate: calendarDate(profile.effectiveAt, timeZone),
          sequence: 0,
          currentUnitCogsRm: profile.currentUnitCogsRm,
          components: clone(profile.components ?? []),
          changedComponentIds: [],
        }],
      });
    }
  }

  async runIdempotent({
    merchantId,
    endpointId,
    key,
    fingerprint,
    execute,
  }) {
    const scopedKey = `${merchantId}\u0000${endpointId}\u0000${key}`;
    const existing = this.#idempotency.get(scopedKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return { conflict: true };
      }
      return { conflict: false, response: clone(await existing.promise) };
    }

    const promise = Promise.resolve().then(execute);
    const claim = { fingerprint, promise };
    this.#idempotency.set(scopedKey, claim);
    try {
      const response = await promise;
      claim.promise = Promise.resolve(clone(response));
      return { conflict: false, response: clone(response) };
    } catch (error) {
      if (this.#idempotency.get(scopedKey) === claim) {
        this.#idempotency.delete(scopedKey);
      }
      throw error;
    }
  }

  async runReceiptReviewMutation({
    merchantId,
    receiptEventId,
  }, execute) {
    const key = `${merchantId}\u0000${receiptEventId}`;
    const previous = this.#receiptReviewMutations.get(key)
      ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(execute);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#receiptReviewMutations.set(key, tail);
    try {
      return await operation;
    } finally {
      if (this.#receiptReviewMutations.get(key) === tail) {
        this.#receiptReviewMutations.delete(key);
      }
    }
  }

  findEventByExternalId(externalId) {
    const eventId = this.#eventsByExternalId.get(externalId);
    return eventId ? this.getEvent(eventId) : null;
  }

  appendEvent(event) {
    if (event.externalId) {
      const existingEventId = this.#eventsByExternalId.get(event.externalId);
      if (existingEventId) {
        return {
          appended: false,
          event: this.getEvent(existingEventId),
        };
      }
    }
    if (this.#eventsById.has(event.eventId)) {
      throw new Error(`Event already exists: ${event.eventId}`);
    }

    const stored = clone({
      ...event,
      ingestedAt: event.ingestedAt ?? new Date().toISOString(),
    });
    this.#events.push(stored);
    this.#eventsById.set(event.eventId, stored);
    if (event.externalId) this.#eventsByExternalId.set(event.externalId, event.eventId);
    return { appended: true, event: clone(stored) };
  }

  appendCorrection(event, { expectedTargetVersion } = {}) {
    if (expectedTargetVersion !== undefined) {
      const targetVersion = this.#events.reduce(
        (version, candidate) =>
          candidate.type === "correction"
          && candidate.targetEventId === event.targetEventId
            ? version + 1
            : version,
        1,
      );
      if (targetVersion !== expectedTargetVersion) {
        return {
          appended: false,
          conflict: true,
          targetVersion,
        };
      }
    }
    return this.appendEvent(event);
  }

  getEvent(eventId) {
    const event = this.#eventsById.get(eventId);
    return event ? clone(event) : null;
  }

  listEvents({
    merchantId,
    date,
    fromDate,
    toDate,
    type,
  } = {}) {
    return this.#events
      .filter((event) => !merchantId || event.merchantId === merchantId)
      .filter((event) => {
        const timeZone = this.#merchantTimeZones.get(event.merchantId)
          ?? "Asia/Kuala_Lumpur";
        const eventDate = calendarDate(event.occurredAt, timeZone);
        if (date && eventDate !== date) return false;
        if (fromDate && eventDate < fromDate) return false;
        if (toDate && eventDate > toDate) return false;
        return true;
      })
      .filter((event) => !type || event.type === type)
      .map(clone);
  }

  getMerchantCalendarDate(merchantId, occurredAt) {
    return calendarDate(
      occurredAt,
      this.#merchantTimeZones.get(merchantId) ?? "Asia/Kuala_Lumpur",
    );
  }

  getProductProfile(productId, { asOfDate, merchantId } = {}) {
    const record = this.#productProfiles.get(productId);
    if (!record || (merchantId && record.merchantId !== merchantId)) return null;
    const cutoff = asOfDate ?? "9999-12-31";
    const snapshot = record.snapshots
      .filter((candidate) => candidate.effectiveDate <= cutoff)
      .sort((left, right) =>
        left.effectiveDate.localeCompare(right.effectiveDate)
        || left.sequence - right.sequence)
      .at(-1);
    if (!snapshot) return null;
    return clone({
      merchantId: record.merchantId,
      productId: record.productId,
      baselineUnitCogsRm: record.baselineUnitCogsRm,
      targetGrossMarginPct: record.targetGrossMarginPct,
      currentUnitCogsRm: snapshot.currentUnitCogsRm,
      components: snapshot.components,
    });
  }

  getProductCostComparison(
    productId,
    { currentDate, comparisonDate, merchantId } = {},
  ) {
    return {
      current: this.getProductProfile(productId, {
        asOfDate: currentDate,
        merchantId,
      }),
      baseline: this.getProductProfile(productId, {
        asOfDate: comparisonDate,
        merchantId,
      }),
    };
  }

  findProductProfilesByComponent(
    merchantId,
    componentId,
    { asOfDate } = {},
  ) {
    return [...this.#productProfiles.keys()]
      .map((productId) =>
        this.getProductProfile(productId, { asOfDate, merchantId }))
      .filter((profile) => profile?.merchantId === merchantId)
      .filter((profile) =>
        profile.components?.some((component) =>
          component.componentId === componentId))
      .map(clone);
  }

  listComponents(merchantId, { asOfDate } = {}) {
    const components = new Map();
    for (const productId of this.#productProfiles.keys()) {
      const profile = this.getProductProfile(productId, {
        asOfDate,
        merchantId,
      });
      for (const component of profile?.components ?? []) {
        if (!components.has(component.componentId)) {
          components.set(component.componentId, {
            componentId: component.componentId,
            name: component.name,
          });
        }
      }
    }
    return [...components.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(clone);
  }

  saveProductProfile(
    profile,
    { effectiveAt, changedComponentIds = [] } = {},
  ) {
    const record = this.#productProfiles.get(profile.productId);
    if (!record) throw new Error(`Unknown product profile: ${profile.productId}`);
    const timeZone = this.#merchantTimeZones.get(profile.merchantId)
      ?? "Asia/Kuala_Lumpur";
    const inserted = {
      effectiveDate: calendarDate(effectiveAt, timeZone),
      sequence: record.snapshots.length,
      currentUnitCogsRm: profile.currentUnitCogsRm,
      components: clone(profile.components ?? []),
      changedComponentIds: [...changedComponentIds],
    };
    record.snapshots.push(inserted);

    const laterSnapshots = record.snapshots
      .filter((snapshot) =>
        snapshot.effectiveDate > inserted.effectiveDate
        || (
          snapshot.effectiveDate === inserted.effectiveDate
          && snapshot.sequence > inserted.sequence
        ))
      .sort((left, right) =>
        left.effectiveDate.localeCompare(right.effectiveDate)
        || left.sequence - right.sequence);
    for (const componentId of changedComponentIds) {
      const source = inserted.components.find(
        (component) => component.componentId === componentId,
      );
      if (!source) continue;
      for (const snapshot of laterSnapshots) {
        if (snapshot.changedComponentIds.includes(componentId)) break;
        const component = snapshot.components.find(
          (candidate) => candidate.componentId === componentId,
        );
        if (!component) continue;
        component.currentCostRm = source.currentCostRm;
        snapshot.currentUnitCogsRm = sumDecimal(
          snapshot.components.map((item) => item.currentCostRm),
        );
      }
    }
  }

  saveClarification(task) {
    const key = task.storageKey ?? task.sourceEventId;
    if (this.#clarificationsBySourceEventId.has(key)) {
      throw new Error(`Clarification already exists: ${key}`);
    }
    this.#clarificationsBySourceEventId.set(key, clone(task));
  }

  getClarificationBySourceEventId(sourceEventId) {
    const task = this.#clarificationsBySourceEventId.get(sourceEventId);
    if (!task) return null;
    const { resolutionPromise: _pending, ...serializable } = task;
    return clone(serializable);
  }

  findClarificationsByRawSourceId(sourceEventId) {
    return [...this.#clarificationsBySourceEventId.values()]
      .filter((task) => task.sourceEventId === sourceEventId)
      .map((task) => {
        const { resolutionPromise: _pending, ...serializable } = task;
        return clone(serializable);
      });
  }

  resolveClarification(sourceEventId, resolution) {
    const task = this.#clarificationsBySourceEventId.get(sourceEventId);
    if (!task) throw new Error(`Unknown clarification: ${sourceEventId}`);
    if (task.resolution) return this.getClarificationBySourceEventId(sourceEventId);
    task.resolution = clone(resolution);
    return this.getClarificationBySourceEventId(sourceEventId);
  }

  async runClarificationResolution(sourceEventId, execute) {
    const task = this.#clarificationsBySourceEventId.get(sourceEventId);
    if (!task) return null;
    if (task.resolution) return clone(task.resolution);
    if (task.resolutionPromise) return clone(await task.resolutionPromise);

    const taskSnapshot = clone(task);
    const promise = Promise.resolve().then(() => execute(taskSnapshot));
    task.resolutionPromise = promise;
    try {
      const resolution = await promise;
      task.resolution = clone(resolution);
      delete task.resolutionPromise;
      return clone(resolution);
    } catch (error) {
      delete task.resolutionPromise;
      throw error;
    }
  }

  healthCheck() {
    return { status: "ok" };
  }
}
