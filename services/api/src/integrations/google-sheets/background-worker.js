import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_LEASE_MS = 60 * 1000;
const DEFAULT_MAX_NOTIFICATIONS = 100;
const DEFAULT_RETRY_DELAY_MS = 30 * 1000;
const DEFAULT_STAGE_TIMEOUT_MS = 60 * 1000;

export function createGoogleSheetsBackgroundWorker({
  integration,
  store,
  processNotification,
  workerId = `google-sheets-${hostname()}-${process.pid}-${randomUUID()}`,
  intervalMs = DEFAULT_INTERVAL_MS,
  notificationLeaseMs = DEFAULT_LEASE_MS,
  maxNotificationsPerRun = DEFAULT_MAX_NOTIFICATIONS,
  stageTimeoutMs = DEFAULT_STAGE_TIMEOUT_MS,
  retryDelayMs = ({ attempts }) =>
    DEFAULT_RETRY_DELAY_MS * Math.min(2 ** Math.max(attempts - 1, 0), 32),
  now = () => Date.now(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  onError = (error) => console.error("Google Sheets background sync failed", error),
}) {
  if (!integration && !(store && processNotification)) {
    throw new Error(
      "integration or store with processNotification is required",
    );
  }
  if ((store && !processNotification) || (!store && processNotification)) {
    throw new Error("store and processNotification must be provided together");
  }
  if (!Number.isFinite(stageTimeoutMs) || stageTimeoutMs <= 0) {
    throw new Error("stageTimeoutMs must be a positive number");
  }
  let timer = null;
  let running = null;
  const stageTasks = new Map();

  function currentTimestamp() {
    return new Date(now()).toISOString();
  }

  function reportError(error, context) {
    try {
      onError(error, context);
    } catch {
      // Error reporting must not starve later worker stages.
    }
  }

  async function processDueNotifications() {
    if (!store) return [];
    const processed = [];
    for (let index = 0; index < maxNotificationsPerRun; index += 1) {
      const notification = await store.claimNotification({
        workerId,
        now: currentTimestamp(),
        leaseMs: notificationLeaseMs,
      });
      if (!notification) break;
      try {
        const result = await processNotification(notification);
        await store.completeNotification({
          notificationId: notification.notificationId,
          claimToken: notification.claimToken,
          processedAt: currentTimestamp(),
        });
        processed.push({ notification, result });
      } catch (error) {
        const failedAt = currentTimestamp();
        await store.failNotification({
          notificationId: notification.notificationId,
          claimToken: notification.claimToken,
          error: error?.message ?? String(error),
          failedAt,
          availableAt: new Date(
            Date.parse(failedAt) + retryDelayMs(notification),
          ).toISOString(),
        });
        reportError(error, notification);
      }
    }
    return processed;
  }

  async function runStage(stage, execute, fallback) {
    if (stageTasks.has(stage)) return fallback;
    const task = Promise.resolve().then(execute);
    stageTasks.set(stage, task);
    void task.finally(() => {
      if (stageTasks.get(stage) === task) stageTasks.delete(stage);
    }).catch(() => {});
    let deadlineTimer;
    const deadline = new Promise((_, reject) => {
      deadlineTimer = setTimeoutImpl(() => {
        reject(new Error(
          `Google Sheets background stage timed out: ${stage}`,
        ));
      }, stageTimeoutMs);
      deadlineTimer?.unref?.();
    });
    try {
      return await Promise.race([task, deadline]);
    } catch (error) {
      reportError(error, { stage });
      return fallback;
    } finally {
      if (deadlineTimer) clearTimeoutImpl(deadlineTimer);
    }
  }

  async function runOnce() {
    if (running) return running;
    running = (async () => {
      await runStage(
        "watch-renewal",
        () => integration?.renewAutomaticWatches?.(),
        undefined,
      );
      const notifications = await runStage(
        "durable-notifications",
        processDueNotifications,
        [],
      );
      if (integration?.runAutomaticSync) {
        return runStage(
          "periodic-sync",
          () => integration.runAutomaticSync(),
          notifications,
        );
      }
      return notifications;
    })();
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  return {
    processDueNotifications,
    runOnce,
    start() {
      if (timer) return;
      timer = setIntervalImpl(() => {
        void runOnce();
      }, intervalMs);
      timer?.unref?.();
    },
    stop() {
      if (!timer) return;
      clearIntervalImpl(timer);
      timer = null;
    },
  };
}
