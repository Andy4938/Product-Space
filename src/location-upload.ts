type TimerHandle = ReturnType<typeof setTimeout>;

export interface LocationUploaderOptions<T extends { recordedAt: string }, R> {
  send: (point: T) => Promise<R>;
  onSuccess: (result: R, point: T) => void;
  onError: (error: unknown) => void;
  getAcceptedRecordedAt: () => number;
  initialLastSuccessAt?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  minIntervalMs?: number;
  retryDelayMs?: number;
  maxAgeMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}

export interface LocationUploader<T extends { recordedAt: string }> {
  push(point: T): void;
  retry(): void;
  stop(): void;
}

/** Serializes GPS uploads, keeping only the newest unsent position. */
export function createLocationUploader<T extends { recordedAt: string }, R>(
  options: LocationUploaderOptions<T, R>,
): LocationUploader<T> {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const minIntervalMs = options.minIntervalMs ?? 1100;
  const retryDelayMs = options.retryDelayMs ?? 2000;
  const maxAgeMs = options.maxAgeMs ?? 105_000;
  const shouldRetry = options.shouldRetry ?? (() => true);
  if (![minIntervalMs, retryDelayMs, maxAgeMs].every(value => Number.isFinite(value) && value >= 0)) {
    throw new RangeError('Location uploader delays must be finite and nonnegative.');
  }

  let pending: T | null = null;
  let sending: T | null = null;
  let timer: TimerHandle | null = null;
  let stopped = false;
  let lastSuccessAt = Number.isFinite(options.initialLastSuccessAt) ? options.initialLastSuccessAt! : -Infinity;
  let lastAcceptedRecordedAt = -Infinity;
  let retryNotBefore = -Infinity;

  const recordedTime = (point: T): number => Date.parse(point.recordedAt);
  const acceptedTime = (): number => {
    const external = options.getAcceptedRecordedAt();
    return Math.max(lastAcceptedRecordedAt, Number.isFinite(external) ? external : -Infinity);
  };
  const usable = (point: T): boolean => {
    const recordedAt = recordedTime(point);
    return Number.isFinite(recordedAt) && recordedAt > acceptedTime() && now() - recordedAt <= maxAgeMs;
  };
  const clearScheduled = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const schedule = (): void => {
    clearScheduled();
    if (stopped || sending) return;
    if (pending && !usable(pending)) pending = null;
    if (!pending) return;
    const delay = Math.max(0, lastSuccessAt + minIntervalMs - now(), retryNotBefore - now());
    if (delay > 0) {
      timer = setTimer(() => {
        timer = null;
        schedule();
      }, delay);
      return;
    }
    const point = pending;
    pending = null;
    sending = point;
    void transmit(point);
  };

  const transmit = async (point: T): Promise<void> => {
    let result: R;
    try {
      result = await options.send(point);
    } catch (error) {
      if (stopped) return;
      const retryable = shouldRetry(error);
      if (retryable && usable(point) && (!pending || recordedTime(point) > recordedTime(pending))) {
        pending = point;
      }
      retryNotBefore = retryable ? now() + retryDelayMs : -Infinity;
      sending = null;
      try {
        options.onError(error);
      } finally {
        schedule();
      }
      return;
    }
    if (stopped) return;
    lastSuccessAt = now();
    lastAcceptedRecordedAt = Math.max(lastAcceptedRecordedAt, recordedTime(point));
    retryNotBefore = -Infinity;
    sending = null;
    try {
      options.onSuccess(result, point);
    } finally {
      schedule();
    }
  };

  return {
    push(point) {
      if (stopped || !usable(point)) return;
      const time = recordedTime(point);
      if (sending && time <= recordedTime(sending)) return;
      if (pending && time <= recordedTime(pending)) return;
      pending = point;
      schedule();
    },
    retry() {
      if (stopped) return;
      retryNotBefore = -Infinity;
      schedule();
    },
    stop() {
      stopped = true;
      pending = null;
      clearScheduled();
    },
  };
}
