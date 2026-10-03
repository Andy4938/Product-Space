const GPS_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 15000,
};

const STALE_AFTER_MS = 10000;
const RECOVERY_SPACING_MS = 10000;
const RECOVERY_GUARD_MS = 16000;

type Timer = unknown;

export interface LocationWatchOptions {
  geolocation: Pick<Geolocation, 'watchPosition' | 'clearWatch' | 'getCurrentPosition'>;
  onPosition: (position: GeolocationPosition) => void;
  onError: (error: GeolocationPositionError | Error) => void;
  isVisible: () => boolean;
  now?: () => number;
  setInterval?: (callback: () => void, delay: number) => Timer;
  clearInterval?: (timer: Timer) => void;
  setTimeout?: (callback: () => void, delay: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
}

export interface LocationWatch {
  stop: () => void;
  /** Check immediately after the page becomes visible or the network returns. */
  refresh: () => void;
}

/**
 * Keeps the browser's normal GPS watch running and requests one fresh fix when
 * captured positions stop advancing. Calling stop invalidates every callback.
 */
export function startLocationWatch(options: LocationWatchOptions): LocationWatch {
  const now = options.now ?? Date.now;
  const scheduleInterval = options.setInterval ?? ((callback, delay) => globalThis.setInterval(callback, delay));
  const cancelInterval = options.clearInterval ?? ((timer) => globalThis.clearInterval(timer as ReturnType<typeof globalThis.setInterval>));
  const scheduleTimeout = options.setTimeout ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
  const cancelTimeout = options.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>));

  let stopped = false;
  let denied = false;
  let watchId: number | null = null;
  let recoveryInFlight = false;
  let recoveryGeneration = 0;
  let recoveryGuard: Timer | null = null;
  let lastCapturedAt = now();
  let lastAcceptedTimestamp = Number.NEGATIVE_INFINITY;
  let lastRecoveryAt = Number.NEGATIVE_INFINITY;

  const invalidateRecovery = () => {
    recoveryGeneration += 1;
    recoveryInFlight = false;
    if (recoveryGuard !== null) {
      cancelTimeout(recoveryGuard);
      recoveryGuard = null;
    }
  };

  const acceptPosition = (position: GeolocationPosition) => {
    if (stopped || !Number.isFinite(position.timestamp) || position.timestamp <= lastAcceptedTimestamp) return;
    lastAcceptedTimestamp = position.timestamp;
    lastCapturedAt = position.timestamp;
    options.onPosition(position);
  };

  const handleError = (error: GeolocationPositionError | Error) => {
    if (stopped) return;
    if ('code' in error && error.code === 1) {
      denied = true;
      invalidateRecovery();
    }
    options.onError(error);
  };

  const refresh = () => {
    if (stopped || denied || recoveryInFlight || !options.isVisible()) return;
    const currentTime = now();
    if (currentTime - lastCapturedAt < STALE_AFTER_MS || currentTime - lastRecoveryAt < RECOVERY_SPACING_MS) return;

    recoveryInFlight = true;
    lastRecoveryAt = currentTime;
    const acceptedAtStart = lastAcceptedTimestamp;
    const generation = ++recoveryGeneration;
    recoveryGuard = scheduleTimeout(() => {
      if (stopped || generation !== recoveryGeneration) return;
      recoveryInFlight = false;
      recoveryGuard = null;
      recoveryGeneration += 1;
      refresh();
    }, RECOVERY_GUARD_MS);

    try {
      options.geolocation.getCurrentPosition(
        (position) => {
          if (stopped || generation !== recoveryGeneration) return;
          invalidateRecovery();
          acceptPosition(position);
        },
        (error) => {
          if (stopped || generation !== recoveryGeneration) return;
          invalidateRecovery();
          if (error.code === 1 || lastAcceptedTimestamp <= acceptedAtStart) handleError(error);
        },
        GPS_OPTIONS,
      );
    } catch (cause) {
      invalidateRecovery();
      handleError(cause instanceof Error ? cause : new Error('Location recovery failed.'));
    }
  };

  try {
    watchId = options.geolocation.watchPosition(acceptPosition, handleError, GPS_OPTIONS);
  } catch (cause) {
    handleError(cause instanceof Error ? cause : new Error('Location watch failed.'));
  }
  const checkTimer = scheduleInterval(refresh, 1000);

  return {
    refresh,
    stop: () => {
      if (stopped) return;
      stopped = true;
      invalidateRecovery();
      cancelInterval(checkTimer);
      if (watchId !== null) options.geolocation.clearWatch(watchId);
    },
  };
}
