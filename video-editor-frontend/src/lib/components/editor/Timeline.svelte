<script lang="ts">
  import { formatTime } from '$lib/utils/time';

  const HANDLE_HALF_WIDTH_PX = 4;
  const PLAYHEAD_WIDTH_PX = 4;
  const END_HANDLE_LEFT_OFFSET_PX = -1;
  const END_STOP_PLAYHEAD_OFFSET_PX = END_HANDLE_LEFT_OFFSET_PX - PLAYHEAD_WIDTH_PX;
  const END_STOP_TIME_TOLERANCE_SECONDS = 0.01;

  let {
    timelineUiTime,
    timelineUiPercent,
    duration,
    startPercent,
    endPercent,
    trimPercent,
    startTime,
    endTime,
    startTimeSeconds,
    endTimeSeconds,
    isDraggingStart,
    isDraggingEnd,
    onTimelineMouseDown,
    onStartMarkerMouseDown,
    onEndMarkerMouseDown,
    onKeydown
  }: {
    timelineUiTime: number;
    timelineUiPercent: number;
    duration: number;
    startPercent: number;
    endPercent: number;
    trimPercent: number;
    startTime: string;
    endTime: string;
    startTimeSeconds: number;
    endTimeSeconds: number;
    isDraggingStart: boolean;
    isDraggingEnd: boolean;
    onTimelineMouseDown: (event: MouseEvent) => void;
    onStartMarkerMouseDown: (event: MouseEvent) => void;
    onEndMarkerMouseDown: (event: MouseEvent) => void;
    onKeydown: (event: KeyboardEvent) => void;
  } = $props();

  const clampPercent = (percent: number) => Math.max(0, Math.min(100, percent));
  const timelineSafeLeft = (percent: number, offsetPx = 0) =>
    `clamp(0%, calc(${clampPercent(percent)}% + ${offsetPx}px), calc(100% - ${PLAYHEAD_WIDTH_PX}px))`;

  let playheadVisualLeft = $derived.by(() => {
    if (isDraggingStart) {
      return timelineSafeLeft(startPercent, HANDLE_HALF_WIDTH_PX);
    }

    if (isDraggingEnd) {
      const offset = END_HANDLE_LEFT_OFFSET_PX - HANDLE_HALF_WIDTH_PX - PLAYHEAD_WIDTH_PX;
      return timelineSafeLeft(endPercent, offset);
    }

    // Keep the red playhead immediately left of the amber handle when playback
    // stops at the trim end. This is visual only; both times remain unchanged.
    if (Math.abs(timelineUiTime - endTimeSeconds) <= END_STOP_TIME_TOLERANCE_SECONDS) {
      return timelineSafeLeft(endPercent, END_STOP_PLAYHEAD_OFFSET_PX);
    }

    return timelineSafeLeft(timelineUiPercent);
  });
</script>

<div
  class="timeline-container relative h-12 bg-gray-950/70 rounded-md cursor-pointer overflow-hidden shadow-inner border border-gray-700/20"
  role="slider"
  tabindex="0"
  aria-label="Video timeline scrubber"
  aria-valuenow={Math.round(timelineUiTime)}
  aria-valuemin="0"
  aria-valuemax={Math.round(duration)}
  onmousedown={onTimelineMouseDown}
  onkeydown={onKeydown}
>
  <!-- Currect time position -->
  <div
    class="absolute top-0 w-1 h-full bg-red-500 shadow-lg z-30"
    style="left: {playheadVisualLeft}"
  >
    <div class="absolute -top-1 left-1/2 transform -translate-x-1/2 w-2 h-2 bg-red-500 rounded-full shadow-lg"></div>
  </div>
  
  <!-- Outside of the timeline -->
  <div
    class="absolute top-0 left-0 h-full bg-gray-600/20"
    style="width: {Math.max(0, Math.min(100, startPercent))}%"
  ></div>
  <div
    class="absolute top-0 h-full bg-gray-600/20"
    style="left: {Math.max(0, Math.min(100, endPercent))}%; width: {Math.max(0, 100 - Math.min(100, endPercent))}%"
  ></div>


  <!-- Start time marker -->
  <div
    class="absolute focus:outline-none top-0 w-2 h-full bg-teal-300  rounded-l-xl shadow-lg z-20 cursor-grab {isDraggingStart ? 'cursor-grabbing' : ''}"
    style="left: {Math.max(0, Math.min(100, startPercent))}%"
    role="slider"
    tabindex="0"
    aria-label="Start time marker"
    aria-valuenow={Math.round(startTimeSeconds * 1000)}
    onmousedown={onStartMarkerMouseDown}
    onkeydown={onKeydown}
  > 
    
  </div>

  <!-- End time marker -->
  <div
    class="absolute focus:outline-none top-0 w-2 h-full bg-amber-500 rounded-r-xl shadow-lg z-20 cursor-grab {isDraggingEnd ? 'cursor-grabbing' : ''}"
    style="left: calc({Math.max(0, Math.min(100, endPercent))}% - 1px)"
    role="slider"
    tabindex="0"
    aria-label="End time marker"
    aria-valuenow={Math.round(endTimeSeconds * 1000)}
    onmousedown={onEndMarkerMouseDown}
    onkeydown={onKeydown}
  ></div>
</div>

<div class="flex justify-between mt-2 text-xs">
  <span class="text-teal-300 font-medium">Start: {startTime}</span>
  <span class="text-slate-400 font-mono">{formatTime(timelineUiTime)}</span>
  <span class="text-amber-300 font-medium">End: {endTime}</span>
</div>

<style>
  .timeline-container {
    user-select: none;
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    outline: none !important;
  }

  .timeline-container:focus {
    outline: none !important;
    box-shadow: none !important;
  }

  .timeline-container > div[role='slider'] {
    transform: translateX(-50%);
    cursor: grab;
  }

  .timeline-container > div[role='slider']:hover {
    filter: brightness(1.0);
  }

  .timeline-container > div[role='slider']:active {
    cursor: grabbing;
  }
</style>

