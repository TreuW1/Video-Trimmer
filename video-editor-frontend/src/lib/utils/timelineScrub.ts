/**
 * Timeline scrubbing: the playhead follows every pointer move, but the decoder handles only
 * one seek at a time. While that seek is in flight, pointer moves replace one pending target;
 * once the requested frame is presented, only the newest target is decoded. This prevents a
 * fast drag from flooding and repeatedly cancelling the browser's video decoder.
 */
export const TIMELINE_SCRUB = {
  minVideoSeekIntervalMs: 16,
  previewFrameIntervalSec: 1 / 60,
  minVideoSeekDeltaSec: 1 / 120,
  preferFastSeek: true
} as const;

export type TimelineScrubConfig = {
  minVideoSeekIntervalMs: number;
  previewFrameIntervalSec: number;
  minVideoSeekDeltaSec: number;
  preferFastSeek: boolean;
};

const BYTES_PER_MEBIBYTE = 1024 * 1024;
const DENSE_MEDIA_BYTES_PER_SECOND = 2 * BYTES_PER_MEBIBYTE;
const TARGET_SEEK_BOX_BYTES = 2 * BYTES_PER_MEBIBYTE;

/**
 * Treat a clip as a sequence of seek boxes whose duration is based on media density.
 * A short, high-bitrate file gets coarser preview seeks, while a long/light file keeps
 * frame-level scrubbing. Releasing the pointer still performs a precise final seek.
 */
export function createAdaptiveTimelineScrubConfig(
  fileSizeBytes: number | null | undefined,
  durationSeconds: number
): TimelineScrubConfig {
  if (
    !Number.isFinite(fileSizeBytes) ||
    (fileSizeBytes ?? 0) <= 0 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return { ...TIMELINE_SCRUB };
  }

  const bytesPerSecond = (fileSizeBytes as number) / durationSeconds;
  if (bytesPerSecond <= DENSE_MEDIA_BYTES_PER_SECOND) {
    return { ...TIMELINE_SCRUB };
  }

  const densityRatio = bytesPerSecond / DENSE_MEDIA_BYTES_PER_SECOND;
  const previewFrameIntervalSec = Math.max(
    1 / 30,
    Math.min(0.5, TARGET_SEEK_BOX_BYTES / bytesPerSecond)
  );

  return {
    minVideoSeekIntervalMs: Math.min(100, 16 + Math.ceil(Math.log2(densityRatio)) * 16),
    previewFrameIntervalSec,
    minVideoSeekDeltaSec: previewFrameIntervalSec * 0.75,
    preferFastSeek: true
  };
}

export type TimelineScrubThrottle = {
  lastVideoTime: number;
  lastSeekAtMs: number;
  pendingVideoTime: number | null;
  seekInFlight: boolean;
  animationFrameId: number;
  generation: number;
  cancelInFlight: (() => void) | null;
};

type TimelineScrubSeekOptions = {
  setUserSeeking: (seeking: boolean) => void;
  config?: TimelineScrubConfig;
  now?: () => number;
};

export function createTimelineScrubThrottle(): TimelineScrubThrottle {
  return {
    lastVideoTime: -1,
    lastSeekAtMs: 0,
    pendingVideoTime: null,
    seekInFlight: false,
    animationFrameId: 0,
    generation: 0,
    cancelInFlight: null
  };
}

export function resetTimelineScrubThrottle(throttle: TimelineScrubThrottle): void {
  throttle.generation++;
  if (throttle.animationFrameId) cancelAnimationFrame(throttle.animationFrameId);
  throttle.cancelInFlight?.();
  throttle.lastVideoTime = -1;
  throttle.lastSeekAtMs = 0;
  throttle.pendingVideoTime = null;
  throttle.seekInFlight = false;
  throttle.animationFrameId = 0;
  throttle.cancelInFlight = null;
}

export function clampTimelineTime(time: number, duration: number): number {
  return Math.max(0, Math.min(duration, time));
}

export function timeFromTimelineClientX(clientX: number, rect: DOMRect, duration: number): number {
  const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
  return clampTimelineTime((x / rect.width) * duration, duration);
}

function nearestPreviewFrame(
  desired: number,
  duration: number,
  config: TimelineScrubConfig
): number {
  const step = config.previewFrameIntervalSec;
  if (step <= 0) return clampTimelineTime(desired, duration);
  return clampTimelineTime(Math.round(desired / step) * step, duration);
}

function schedulePendingVideoSeek(
  player: HTMLVideoElement,
  throttle: TimelineScrubThrottle,
  options: TimelineScrubSeekOptions,
  config: TimelineScrubConfig
): void {
  if (throttle.seekInFlight || throttle.animationFrameId || throttle.pendingVideoTime === null) {
    return;
  }

  const generation = throttle.generation;
  const run = () => {
    throttle.animationFrameId = 0;
    if (
      generation !== throttle.generation ||
      throttle.seekInFlight ||
      throttle.pendingVideoTime === null
    ) {
      return;
    }

    const now = options.now?.() ?? performance.now();
    if (now - throttle.lastSeekAtMs < config.minVideoSeekIntervalMs) {
      throttle.animationFrameId = requestAnimationFrame(run);
      return;
    }

    const target = throttle.pendingVideoTime;
    throttle.pendingVideoTime = null;
    throttle.seekInFlight = true;
    throttle.lastVideoTime = target;
    throttle.lastSeekAtMs = now;
    options.setUserSeeking(true);
    player.pause();

    let frameCallbackId = 0;
    let fallbackTimeoutId = 0;
    let finished = false;
    const startedAt = performance.now();

    const cleanup = () => {
      player.removeEventListener('seeked', handleSeeked);
      if (frameCallbackId && player.cancelVideoFrameCallback) {
        player.cancelVideoFrameCallback(frameCallbackId);
      }
      if (fallbackTimeoutId) clearTimeout(fallbackTimeoutId);
    };

    const finish = () => {
      if (finished || generation !== throttle.generation) return;
      finished = true;
      cleanup();
      throttle.cancelInFlight = null;
      throttle.seekInFlight = false;
      if (
        throttle.pendingVideoTime !== null &&
        Math.abs(throttle.pendingVideoTime - throttle.lastVideoTime) < config.minVideoSeekDeltaSec
      ) {
        throttle.pendingVideoTime = null;
      }
      schedulePendingVideoSeek(player, throttle, options, config);
    };

    const waitUntilSeekCompletes = () => {
      if (finished || generation !== throttle.generation) return;
      if (!player.seeking || performance.now() - startedAt >= 3000) {
        finish();
        return;
      }
      fallbackTimeoutId = window.setTimeout(waitUntilSeekCompletes, 50);
    };

    let usedFastSeek = false;

    const handleVideoFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (finished || generation !== throttle.generation) return;
      const tolerance = Math.max(config.previewFrameIntervalSec, 0.05);
      if (Math.abs(metadata.mediaTime - target) <= tolerance) {
        finish();
      } else {
        frameCallbackId = player.requestVideoFrameCallback(handleVideoFrame);
      }
    };

    function handleSeeked(): void {
      // fastSeek intentionally lands on a nearby keyframe. That presented keyframe is
      // sufficient during drag; pointer release follows with a precise currentTime seek.
      if (usedFastSeek) {
        finish();
        return;
      }

      // `requestVideoFrameCallback` confirms presentation. The short fallback covers WebViews
      // that implement the API but do not fire it consistently for a paused seek.
      if (!player.requestVideoFrameCallback) {
        finish();
      } else {
        if (fallbackTimeoutId) clearTimeout(fallbackTimeoutId);
        fallbackTimeoutId = window.setTimeout(waitUntilSeekCompletes, 50);
      }
    }

    throttle.cancelInFlight = cleanup;
    player.addEventListener('seeked', handleSeeked);
    if (player.requestVideoFrameCallback) {
      frameCallbackId = player.requestVideoFrameCallback(handleVideoFrame);
    }
    fallbackTimeoutId = window.setTimeout(waitUntilSeekCompletes, 250);

    const fastSeek = (player as HTMLVideoElement & { fastSeek?: (time: number) => void }).fastSeek;
    if (config.preferFastSeek && typeof fastSeek === 'function') {
      try {
        usedFastSeek = true;
        fastSeek.call(player, target);
        return;
      } catch {
        usedFastSeek = false;
      }
    }

    player.currentTime = target;
  };

  throttle.animationFrameId = requestAnimationFrame(run);
}

export function trySmoothVideoSeek(
  player: HTMLVideoElement,
  desiredUiTime: number,
  duration: number,
  throttle: TimelineScrubThrottle,
  options: TimelineScrubSeekOptions
): void {
  const config = options.config ?? TIMELINE_SCRUB;
  const previewTime = nearestPreviewFrame(desiredUiTime, duration, config);
  const latestTarget = throttle.pendingVideoTime ?? throttle.lastVideoTime;
  if (
    latestTarget >= 0 &&
    Math.abs(previewTime - latestTarget) < config.minVideoSeekDeltaSec
  ) {
    return;
  }

  throttle.pendingVideoTime = previewTime;
  schedulePendingVideoSeek(player, throttle, options, config);
}

export function preciseVideoSeek(
  player: HTMLVideoElement,
  time: number,
  duration: number,
  options: {
    setUserSeeking: (seeking: boolean) => void;
    setCurrentTime: (time: number) => void;
    getSeekTimeout: () => number | 0;
    setSeekTimeout: (timeout: number | 0) => void;
    onSettled?: () => void;
  }
): void {
  const target = clampTimelineTime(time, duration);
  const startedAt = performance.now();
  let settled = false;
  let timeoutId: number | 0 = 0;

  options.setUserSeeking(true);
  player.pause();

  const settle = () => {
    if (settled) return;
    settled = true;
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = 0;
      options.setSeekTimeout(0);
    }
    options.setUserSeeking(false);
    options.onSettled?.();
  };

  const handleSeeked = () => {
    options.setCurrentTime(player.currentTime);
    settle();
  };

  try {
    player.addEventListener('seeked', handleSeeked, { once: true });
  } catch {
    player.addEventListener('seeked', handleSeeked);
    window.setTimeout(() => player.removeEventListener('seeked', handleSeeked), 2000);
  }

  const seekTimeout = options.getSeekTimeout();
  if (seekTimeout) clearTimeout(seekTimeout);

  const fallbackSettle = () => {
    if (settled) return;
    if (player.seeking && performance.now() - startedAt < 3000) {
      timeoutId = window.setTimeout(fallbackSettle, 100);
      options.setSeekTimeout(timeoutId);
      return;
    }

    options.setCurrentTime(player.currentTime);
    settle();
  };

  timeoutId = window.setTimeout(fallbackSettle, 600);
  options.setSeekTimeout(timeoutId);
  player.currentTime = target;
}
