/**
 * Shared timeline viewport behavior. Keeping zoom math, ruler intervals, and
 * waveform sampling here lets future timeline lanes use the same time scale.
 */
export const TIMELINE_VIEWPORT = {
  minZoom: 1,
  maxZoom: 16,
  wheelSensitivity: 0.002,
  rulerTargetSpacingPx: 88,
  waveformDisplayBars: 480,
  waveformMaxDisplayBars: 960,
  waveformSourcePoints: 15360
} as const;

export type TimelineViewport = {
  zoom: number;
  startTime: number;
};

export type TimelineViewportRange = TimelineViewport & {
  endTime: number;
  duration: number;
};

export type TimelineTick = {
  time: number;
  percent: number;
  label: string;
};

export type VisibleTimelineRange = {
  startPercent: number;
  widthPercent: number;
};

const MIN_RULER_INTERVAL_SECONDS = 0.001;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

const finiteDuration = (duration: number): number =>
  Number.isFinite(duration) && duration > 0 ? duration : 0;

export function createTimelineViewport(): TimelineViewport {
  return { zoom: TIMELINE_VIEWPORT.minZoom, startTime: 0 };
}

export function getTimelineViewportRange(
  viewport: TimelineViewport,
  clipDuration: number
): TimelineViewportRange {
  const safeDuration = finiteDuration(clipDuration);
  const zoom = clamp(
    Number.isFinite(viewport.zoom) ? viewport.zoom : TIMELINE_VIEWPORT.minZoom,
    TIMELINE_VIEWPORT.minZoom,
    TIMELINE_VIEWPORT.maxZoom
  );
  const visibleDuration = safeDuration > 0 ? safeDuration / zoom : 0;
  const maximumStart = Math.max(0, safeDuration - visibleDuration);
  const startTime = clamp(
    Number.isFinite(viewport.startTime) ? viewport.startTime : 0,
    0,
    maximumStart
  );

  return {
    zoom,
    startTime,
    endTime: startTime + visibleDuration,
    duration: visibleDuration
  };
}

/** Zooms around the pointer so the time beneath it stays stationary. */
export function zoomTimelineViewport(
  viewport: TimelineViewport,
  clipDuration: number,
  pointerRatio: number,
  wheelDeltaPixels: number
): TimelineViewport {
  const safeDuration = finiteDuration(clipDuration);
  if (safeDuration === 0 || !Number.isFinite(wheelDeltaPixels) || wheelDeltaPixels === 0) {
    return getTimelineViewportRange(viewport, safeDuration);
  }

  const current = getTimelineViewportRange(viewport, safeDuration);
  const anchorRatio = clamp(Number.isFinite(pointerRatio) ? pointerRatio : 0.5, 0, 1);
  const nextZoom = clamp(
    current.zoom * Math.exp(-wheelDeltaPixels * TIMELINE_VIEWPORT.wheelSensitivity),
    TIMELINE_VIEWPORT.minZoom,
    TIMELINE_VIEWPORT.maxZoom
  );

  // The default is also the hard maximum zoom-out state.
  if (nextZoom <= TIMELINE_VIEWPORT.minZoom + Number.EPSILON) {
    return createTimelineViewport();
  }

  const anchorTime = current.startTime + current.duration * anchorRatio;
  const nextDuration = safeDuration / nextZoom;
  const nextStart = clamp(
    anchorTime - nextDuration * anchorRatio,
    0,
    safeDuration - nextDuration
  );

  return { zoom: nextZoom, startTime: nextStart };
}

/** Moves the visible timeline window without changing its zoom level. */
export function panTimelineViewport(
  viewport: TimelineViewport,
  clipDuration: number,
  startTime: number
): TimelineViewport {
  return getTimelineViewportRange(
    {
      zoom: viewport.zoom,
      startTime: Number.isFinite(startTime) ? startTime : viewport.startTime
    },
    clipDuration
  );
}

export function timeToTimelinePercent(
  time: number,
  viewport: TimelineViewport,
  clipDuration: number
): number {
  const range = getTimelineViewportRange(viewport, clipDuration);
  if (range.duration <= 0) return 0;
  return ((time - range.startTime) / range.duration) * 100;
}

export function isTimeVisibleInTimeline(
  time: number,
  viewport: TimelineViewport,
  clipDuration: number
): boolean {
  const range = getTimelineViewportRange(viewport, clipDuration);
  return time >= range.startTime - 0.0005 && time <= range.endTime + 0.0005;
}

/** Clips a media range to the visible window and returns display percentages. */
export function getVisibleTimelineRange(
  startTime: number,
  endTime: number,
  viewport: TimelineViewport,
  clipDuration: number
): VisibleTimelineRange | null {
  const range = getTimelineViewportRange(viewport, clipDuration);
  if (range.duration <= 0 || endTime <= range.startTime || startTime >= range.endTime) {
    return null;
  }

  const visibleStart = clamp(startTime, range.startTime, range.endTime);
  const visibleEnd = clamp(endTime, range.startTime, range.endTime);
  if (visibleEnd <= visibleStart) return null;

  return {
    startPercent: ((visibleStart - range.startTime) / range.duration) * 100,
    widthPercent: ((visibleEnd - visibleStart) / range.duration) * 100
  };
}

function niceTimelineInterval(rawInterval: number): number {
  const safeInterval = Math.max(MIN_RULER_INTERVAL_SECONDS, rawInterval);
  const exponent = Math.floor(Math.log10(safeInterval));
  const magnitude = 10 ** exponent;
  const normalized = safeInterval / magnitude;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * magnitude;
}

function formatTimelineTick(time: number, interval: number, clipDuration: number): string {
  const fractionalDigits = interval < 1
    ? Math.min(3, Math.max(1, Math.ceil(-Math.log10(interval))))
    : 0;
  const unitsPerSecond = 10 ** fractionalDigits;
  const totalUnits = Math.max(0, Math.round(time * unitsPerSecond));
  const totalSeconds = Math.floor(totalUnits / unitsPerSecond);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const fraction = totalUnits % unitsPerSecond;
  const secondsLabel = `${String(seconds).padStart(2, '0')}${
    fractionalDigits > 0
      ? `.${String(fraction).padStart(fractionalDigits, '0')}`
      : ''
  }`;

  if (hours > 0 || clipDuration >= 3600) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secondsLabel}`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  return `${String(totalMinutes).padStart(2, '0')}:${secondsLabel}`;
}

/** Creates evenly spaced, human-friendly 1/2/5-based ruler ticks. */
export function createTimelineTicks(
  viewport: TimelineViewport,
  clipDuration: number,
  widthPixels: number
): TimelineTick[] {
  const range = getTimelineViewportRange(viewport, clipDuration);
  if (range.duration <= 0) return [];

  const targetIntervals = Math.max(
    1,
    Math.floor(Math.max(TIMELINE_VIEWPORT.rulerTargetSpacingPx, widthPixels) /
      TIMELINE_VIEWPORT.rulerTargetSpacingPx)
  );
  const interval = niceTimelineInterval(range.duration / targetIntervals);
  const firstTickIndex = Math.ceil((range.startTime - interval * 1e-7) / interval);
  const lastTickIndex = Math.floor((range.endTime + interval * 1e-7) / interval);
  const ticks: TimelineTick[] = [];

  for (let index = firstTickIndex; index <= lastTickIndex; index += 1) {
    const time = index * interval;
    ticks.push({
      time,
      percent: ((time - range.startTime) / range.duration) * 100,
      label: formatTimelineTick(time, interval, clipDuration)
    });
  }

  return ticks;
}

/**
 * Uses power-of-two buckets so wheel gestures do not create a new backend
 * waveform cache entry for every fractional zoom value.
 */
export function getWaveformSourcePointCount(zoom: number): number {
  const safeZoom = clamp(
    Number.isFinite(zoom) ? zoom : TIMELINE_VIEWPORT.minZoom,
    TIMELINE_VIEWPORT.minZoom,
    TIMELINE_VIEWPORT.maxZoom
  );
  const resolutionMultiplier = safeZoom <= 1
    ? 1
    : 2 ** Math.ceil(Math.log2(safeZoom));
  return Math.min(
    TIMELINE_VIEWPORT.waveformSourcePoints,
    TIMELINE_VIEWPORT.waveformMaxDisplayBars * resolutionMultiplier
  );
}

/**
 * Keeps the on-screen waveform budget fixed at every zoom level. Zoom changes
 * which high-resolution source bins are visible, not how many bars are drawn,
 * so detail improves without increasing the normal 1x rendering workload.
 */
export function getWaveformDisplayBarCount(widthPixels = 0): number {
  if (!Number.isFinite(widthPixels) || widthPixels <= 0) {
    return TIMELINE_VIEWPORT.waveformDisplayBars;
  }

  return Math.round(clamp(
    widthPixels / 2,
    TIMELINE_VIEWPORT.waveformDisplayBars / 2,
    TIMELINE_VIEWPORT.waveformMaxDisplayBars
  ));
}

/**
 * Selects only the source bins in view, aggregating them when needed so the
 * DOM remains a stable size while higher zoom levels reveal finer source bins.
 */
export function sampleWaveformForViewport(
  peaks: number[],
  viewport: TimelineViewport,
  clipDuration: number,
  targetBars: number = TIMELINE_VIEWPORT.waveformDisplayBars
): number[] {
  const safeDuration = finiteDuration(clipDuration);
  if (peaks.length === 0 || safeDuration === 0 || targetBars <= 0) return [];

  const range = getTimelineViewportRange(viewport, safeDuration);
  const startIndex = clamp(
    Math.floor((range.startTime / safeDuration) * peaks.length),
    0,
    peaks.length - 1
  );
  const endIndex = clamp(
    Math.ceil((range.endTime / safeDuration) * peaks.length),
    startIndex + 1,
    peaks.length
  );
  const sourceCount = endIndex - startIndex;
  const outputCount = Math.max(1, Math.floor(targetBars));
  const result = new Array<number>(outputCount);

  // A higher-detail request can still be in flight when the user zooms. Fill
  // the lane by interpolating the available bins instead of stretching a few
  // very wide bars across it; the real samples replace these as soon as the
  // full-resolution waveform arrives.
  if (sourceCount < outputCount) {
    for (let outputIndex = 0; outputIndex < outputCount; outputIndex += 1) {
      const sourcePosition = outputCount === 1
        ? 0
        : (outputIndex / (outputCount - 1)) * Math.max(0, sourceCount - 1);
      const leftIndex = startIndex + Math.floor(sourcePosition);
      const rightIndex = Math.min(endIndex - 1, leftIndex + 1);
      const ratio = sourcePosition - Math.floor(sourcePosition);
      const leftValue = Number.isFinite(peaks[leftIndex]) ? peaks[leftIndex] : 0;
      const rightValue = Number.isFinite(peaks[rightIndex]) ? peaks[rightIndex] : leftValue;
      result[outputIndex] = leftValue + (rightValue - leftValue) * ratio;
    }
    return result;
  }

  for (let outputIndex = 0; outputIndex < outputCount; outputIndex += 1) {
    const binStart = startIndex + Math.floor((outputIndex / outputCount) * sourceCount);
    const binEnd = startIndex + Math.max(
      Math.floor(((outputIndex + 1) / outputCount) * sourceCount),
      Math.floor((outputIndex / outputCount) * sourceCount) + 1
    );
    let maximum = 0;
    let squaredSum = 0;
    let sampleCount = 0;
    for (let sourceIndex = binStart; sourceIndex < binEnd; sourceIndex += 1) {
      const value = peaks[sourceIndex];
      if (!Number.isFinite(value)) continue;
      const normalized = clamp(value, 0, 1);
      maximum = Math.max(maximum, normalized);
      squaredSum += normalized * normalized;
      sampleCount += 1;
    }
    if (sampleCount === 0) {
      result[outputIndex] = 0;
      continue;
    }

    // Max-pooling makes nearly every bar hit the ceiling when just one source
    // bin is loud. Use the bin's RMS body and retain a small transient portion
    // so loud detail survives without erasing short peaks entirely.
    const rms = Math.sqrt(squaredSum / sampleCount);
    result[outputIndex] = rms * 0.85 + maximum * 0.15;
  }

  return result;
}
