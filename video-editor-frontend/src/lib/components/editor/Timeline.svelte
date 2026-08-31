<script lang="ts">
  import type { AudioMuteRange, AudioOutputMode, TrimRange } from '$lib/types/editor';
  import { findClosestTrimRangeIndex } from '$lib/utils/timeRanges';
  import {
    createTimelineTicks,
    getWaveformDisplayBarCount,
    getTimelineViewportRange,
    getVisibleTimelineRange,
    isTimeVisibleInTimeline,
    sampleWaveformForViewport,
    timeToTimelinePercent,
    type TimelineViewport
  } from '$lib/utils/timelineViewport';

  const HANDLE_HALF_WIDTH_PX = 4;
  const PLAYHEAD_WIDTH_PX = 4;
  const END_HANDLE_LEFT_OFFSET_PX = -1;
  const END_STOP_PLAYHEAD_OFFSET_PX = END_HANDLE_LEFT_OFFSET_PX - PLAYHEAD_WIDTH_PX;
  const END_STOP_TIME_TOLERANCE_SECONDS = 0.01;
  const DEFAULT_MUTE_RANGE_SECONDS = 1;
  const MIN_MUTE_RANGE_SECONDS = 0.05;

  type MuteRangeDragMode = 'move' | 'start' | 'end';
  type MuteRangeDrag = {
    index: number;
    mode: MuteRangeDragMode;
    pointerId: number;
    originClientX: number;
    originRange: AudioMuteRange;
    previewRange: AudioMuteRange;
    waveformWidth: number;
  };

  let {
    timelineUiTime,
    duration,
    startTimeSeconds,
    endTimeSeconds,
    timelineViewport,
    isDraggingStart,
    isDraggingEnd,
    waveformPeaks,
    waveformLoading,
    waveformHasAudio,
    audioDetached,
    audioWaveformHidden,
    audioWaveformGloballyHidden,
    audioOutputMode,
    audioMuteRanges,
    selectedAudioMuteRangeIndex,
    trimRanges,
    activeTrimRangeIndex,
    onTimelineMouseDown,
    onStartMarkerMouseDown,
    onEndMarkerMouseDown,
    onTimelineZoom,
    onTimelinePan,
    resetTimelineZoom,
    onKeydown,
    setAudioDetached,
    setAudioWaveformHidden,
    setAudioWaveformsHidden,
    setAudioOutputMode,
    setAudioMuteRanges,
    selectAudioMuteRange,
    selectTrimRange,
  }: {
    timelineUiTime: number;
    duration: number;
    startTimeSeconds: number;
    endTimeSeconds: number;
    timelineViewport: TimelineViewport;
    isDraggingStart: boolean;
    isDraggingEnd: boolean;
    waveformPeaks: number[];
    waveformLoading: boolean;
    waveformHasAudio: boolean | null;
    audioDetached: boolean;
    audioWaveformHidden: boolean;
    audioWaveformGloballyHidden: boolean;
    audioOutputMode: AudioOutputMode;
    audioMuteRanges: AudioMuteRange[];
    selectedAudioMuteRangeIndex: number | null;
    trimRanges: TrimRange[];
    activeTrimRangeIndex: number;
    onTimelineMouseDown: (event: MouseEvent) => void;
    onStartMarkerMouseDown: (event: MouseEvent) => void;
    onEndMarkerMouseDown: (event: MouseEvent) => void;
    onTimelineZoom: (wheelDeltaPixels: number, pointerRatio: number) => void;
    onTimelinePan: (startTime: number) => void;
    resetTimelineZoom: () => void;
    onKeydown: (event: KeyboardEvent) => void;
    setAudioDetached: (detached: boolean) => void;
    setAudioWaveformHidden: (hidden: boolean) => void;
    setAudioWaveformsHidden: (hidden: boolean) => void;
    setAudioOutputMode: (mode: AudioOutputMode) => void;
    setAudioMuteRanges: (ranges: AudioMuteRange[]) => void;
    selectAudioMuteRange: (index: number | null) => void;
    selectTrimRange: (index: number, seekToStart?: boolean) => void;
  } = $props();

  let audioMenuOpen = $state(false);
  let audioMenuX = $state(0);
  let audioMenuY = $state(0);
  let audioMenuDialog = $state<HTMLDialogElement>();
  let muteRangeStart = $state('');
  let muteRangeEnd = $state('');
  let muteRangeError = $state('');
  let waveformTrack = $state<HTMLDivElement>();
  let muteRangeDrag = $state<MuteRangeDrag | null>(null);
  let timelineWidth = $state(0);
  let timelinePanWidth = $state(0);

  const clampPercent = (percent: number) => Math.max(0, Math.min(100, percent));
  const timelineSafeLeft = (percent: number, offsetPx = 0) =>
    `clamp(0%, calc(${clampPercent(percent)}% + ${offsetPx}px), calc(100% - ${PLAYHEAD_WIDTH_PX}px))`;

  function formatTimelineTime(seconds: number): string {
    const totalMilliseconds = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
    const hours = Math.floor(totalMilliseconds / 3_600_000);
    const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
    const wholeSeconds = Math.floor((totalMilliseconds % 60_000) / 1000);
    const milliseconds = totalMilliseconds % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
  }

  function parseTimelineTime(value: string): number {
    const parts = value.trim().split(':');
    if (parts.length > 3 || parts.length === 0) return Number.NaN;
    const numericParts = parts.map(Number);
    if (numericParts.some((part) => !Number.isFinite(part) || part < 0)) return Number.NaN;
    return numericParts.reduce((total, part) => total * 60 + part, 0);
  }

  let viewportRange = $derived(getTimelineViewportRange(timelineViewport, duration));
  let timelineTicks = $derived(createTimelineTicks(timelineViewport, duration, timelineWidth));
  let playheadTime = $derived(
    isDraggingStart ? startTimeSeconds : isDraggingEnd ? endTimeSeconds : timelineUiTime
  );
  let playheadIsVisible = $derived(
    isTimeVisibleInTimeline(playheadTime, timelineViewport, duration)
  );
  let playheadVisualLeft = $derived.by(() => {
    const visiblePercent = timeToTimelinePercent(playheadTime, timelineViewport, duration);
    if (isDraggingStart) return timelineSafeLeft(visiblePercent, HANDLE_HALF_WIDTH_PX);
    if (isDraggingEnd) {
      const offset = END_HANDLE_LEFT_OFFSET_PX - HANDLE_HALF_WIDTH_PX - PLAYHEAD_WIDTH_PX;
      return timelineSafeLeft(visiblePercent, offset);
    }
    if (Math.abs(timelineUiTime - endTimeSeconds) <= END_STOP_TIME_TOLERANCE_SECONDS) {
      return timelineSafeLeft(visiblePercent, END_STOP_PLAYHEAD_OFFSET_PX);
    }
    return timelineSafeLeft(visiblePercent);
  });
  let highlightedTrimRangeIndex = $derived(
    isDraggingStart || isDraggingEnd
      ? activeTrimRangeIndex
      : findClosestTrimRangeIndex(trimRanges, timelineUiTime)
  );

  let waveformDisplayBarCount = $derived(getWaveformDisplayBarCount(timelineWidth));
  let maximumViewportStart = $derived(Math.max(0, duration - viewportRange.duration));
  let viewportThumbWidth = $derived(
    Math.max(32, timelinePanWidth / Math.max(1, viewportRange.zoom))
  );
  let displayWaveformPeaks = $derived(
    sampleWaveformForViewport(
      waveformPeaks,
      timelineViewport,
      duration,
      waveformDisplayBarCount
    )
  );
  let waveformPath = $derived.by(() => {
    const count = displayWaveformPeaks.length;
    if (count === 0) return '';
    return displayWaveformPeaks.map((peak, index) => {
      const height = Math.max(4, peak * 96);
      const x = ((index + 0.5) / count) * 100;
      return `M${x.toFixed(4)} 100V${(100 - height).toFixed(3)}`;
    }).join('');
  });
  let excludedTrimRanges = $derived.by(() => {
    const excluded: TrimRange[] = [];
    let cursor = 0;
    for (const range of trimRanges) {
      if (range.startTime > cursor) {
        excluded.push({ startTime: cursor, endTime: range.startTime });
      }
      cursor = Math.max(cursor, range.endTime);
    }
    if (cursor < duration) excluded.push({ startTime: cursor, endTime: duration });
    return excluded;
  });

  function setMuteDraftFromPlayback(): void {
    const playbackTime = Math.max(0, Math.min(duration, timelineUiTime));
    muteRangeStart = formatTimelineTime(playbackTime);
    muteRangeEnd = formatTimelineTime(
      Math.min(duration, playbackTime + DEFAULT_MUTE_RANGE_SECONDS)
    );
    muteRangeError = '';
  }

  function positionAudioMenu(clientX: number, clientY: number): void {
    const menuWidth = 288;
    const menuHeight = 560;
    audioMenuX = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, clientX));
    audioMenuY = Math.max(8, Math.min(window.innerHeight - menuHeight - 8, clientY));
    if (!muteRangeStart && !muteRangeEnd) {
      setMuteDraftFromPlayback();
    }
    audioMenuOpen = true;
    if (!audioMenuDialog?.open) audioMenuDialog?.showModal();
  }

  function openAudioMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    positionAudioMenu(event.clientX, event.clientY);
  }

  function openAudioMenuAtPlayback(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    setMuteDraftFromPlayback();
    positionAudioMenu(event.clientX, event.clientY);
  }

  function openAudioMenuFromButton(event: MouseEvent): void {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLButtonElement).getBoundingClientRect();
    positionAudioMenu(rect.right - 288, rect.bottom + 6);
  }

  function closeAudioMenu(): void {
    audioMenuOpen = false;
    if (audioMenuDialog?.open) audioMenuDialog.close();
  }

  function closeAudioMenuFromBackdrop(event: MouseEvent): void {
    const rect = audioMenuDialog?.getBoundingClientRect();
    if (
      rect &&
      (event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom)
    ) {
      closeAudioMenu();
    }
  }

  function chooseAudioMode(mode: AudioOutputMode): void {
    setAudioOutputMode(mode);
    if (mode !== 'keep') setAudioDetached(true);
  }

  function toggleAudioDetached(): void {
    const detached = !audioDetached;
    setAudioDetached(detached);
    if (!detached && audioOutputMode === 'extract') setAudioOutputMode('keep');
  }

  function addAudioMuteRange(): void {
    const startTime = parseTimelineTime(muteRangeStart);
    const endTime = parseTimelineTime(muteRangeEnd);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
      muteRangeError = 'Enter valid times in HH:MM:SS.mmm format.';
      return;
    }
    if (startTime < 0 || endTime <= startTime || endTime > duration + 0.001) {
      muteRangeError = `Choose a range between 0 and ${formatTimelineTime(duration)}.`;
      return;
    }

    setAudioMuteRanges([...audioMuteRanges, { startTime, endTime }]);
    setAudioDetached(true);
    muteRangeError = '';
    muteRangeStart = formatTimelineTime(endTime);
    muteRangeEnd = formatTimelineTime(Math.min(duration, endTime + 1));
    closeAudioMenu();
  }

  function removeAudioMuteRange(index: number): void {
    if (selectedAudioMuteRangeIndex === index) {
      selectAudioMuteRange(null);
    } else if (selectedAudioMuteRangeIndex !== null && selectedAudioMuteRangeIndex > index) {
      selectAudioMuteRange(selectedAudioMuteRangeIndex - 1);
    }
    setAudioMuteRanges(audioMuteRanges.filter((_, rangeIndex) => rangeIndex !== index));
  }

  function beginMuteRangeDrag(
    event: PointerEvent,
    index: number,
    mode: MuteRangeDragMode
  ): void {
    if (event.button !== 0 || !waveformTrack || duration <= 0) return;
    const range = audioMuteRanges[index];
    const waveformWidth = waveformTrack.getBoundingClientRect().width;
    if (!range || waveformWidth <= 0) return;

    event.preventDefault();
    event.stopPropagation();
    selectAudioMuteRange(index);
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    muteRangeDrag = {
      index,
      mode,
      pointerId: event.pointerId,
      originClientX: event.clientX,
      originRange: { ...range },
      previewRange: { ...range },
      waveformWidth
    };
  }

  function handleMuteRangePointerMove(event: PointerEvent): void {
    const drag = muteRangeDrag;
    if (!drag || event.pointerId !== drag.pointerId || duration <= 0) return;
    event.preventDefault();

    const deltaSeconds =
      ((event.clientX - drag.originClientX) / drag.waveformWidth) * viewportRange.duration;
    const originalLength = drag.originRange.endTime - drag.originRange.startTime;
    let startTime = drag.originRange.startTime;
    let endTime = drag.originRange.endTime;

    if (drag.mode === 'move') {
      startTime = Math.max(0, Math.min(duration - originalLength, startTime + deltaSeconds));
      endTime = startTime + originalLength;
    } else if (drag.mode === 'start') {
      startTime = Math.max(0, Math.min(endTime - MIN_MUTE_RANGE_SECONDS, startTime + deltaSeconds));
    } else {
      endTime = Math.min(duration, Math.max(startTime + MIN_MUTE_RANGE_SECONDS, endTime + deltaSeconds));
    }

    muteRangeDrag = {
      ...drag,
      previewRange: { startTime, endTime }
    };
  }

  function finishMuteRangeDrag(event: PointerEvent): void {
    const drag = muteRangeDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();

    const updatedRanges = audioMuteRanges.map((range, index) =>
      index === drag.index ? drag.previewRange : range
    );
    muteRangeDrag = null;
    setAudioMuteRanges(updatedRanges);
  }

  function normalizeWheelDelta(event: WheelEvent): number {
    if (event.deltaMode === 1) return event.deltaY * 16;
    if (event.deltaMode === 2) return event.deltaY * window.innerHeight;
    return event.deltaY;
  }

  function handleTimelineWheel(event: WheelEvent): void {
    if (duration <= 0) return;
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const pointerRatio = rect.width > 0
      ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
      : 0.5;
    onTimelineZoom(normalizeWheelDelta(event), pointerRatio);
  }

  function handleTimelinePanInput(event: Event): void {
    const startTime = (event.currentTarget as HTMLInputElement).valueAsNumber;
    if (Number.isFinite(startTime)) onTimelinePan(startTime);
  }

  function releaseTimelinePanFocus(event: Event): void {
    (event.currentTarget as HTMLInputElement).blur();
  }
</script>

<svelte:window
  onpointermove={handleMuteRangePointerMove}
  onpointerup={finishMuteRangeDrag}
  onpointercancel={finishMuteRangeDrag}
/>

<div class="relative" role="group" aria-label="Video and audio timeline">
  <div class="mb-1.5 focus:outline-none flex items-center justify-between gap-3">
    <div class="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-slate-500">
      <span>Video</span>
      <span class="normal-case tracking-normal text-slate-600">Wheel to zoom · Right-click for audio</span>
    </div>
    <div class="flex items-center gap-2">
      <div class="flex items-center gap-2 text-[12px] font-medium leading-none">
        <span class="text-slate-400">Section {highlightedTrimRangeIndex >= 0 ? highlightedTrimRangeIndex + 1 : 0}/{trimRanges.length}</span>
      </div>
      <button
        type="button"
        class="rounded-md border border-gray-700/70 bg-gray-950/45 px-2 py-1 text-[11px] font-medium tabular-nums text-slate-400 transition-colors hover:bg-gray-800 hover:text-slate-200 disabled:cursor-default disabled:hover:bg-gray-950/45 disabled:hover:text-slate-400"
        onclick={resetTimelineZoom}
        disabled={viewportRange.zoom <= 1}
        title={viewportRange.zoom > 1 ? 'Reset timeline zoom' : 'Timeline is at its default zoom'}
        aria-label={viewportRange.zoom > 1 ? `Reset ${viewportRange.zoom.toFixed(1)} times timeline zoom` : 'Timeline zoom is at default'}
      >
        {viewportRange.zoom.toFixed(1)}×
      </button>
      <button
        type="button"
        class="flex focus:outline-none items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors {audioOutputMode === 'mute'
          ? 'border-red-400/55 bg-red-950/45 text-red-100 shadow-[0_0_0_1px_rgba(248,113,113,0.08)] hover:bg-red-900/45'
          : audioDetached
            ? 'border-amber-400/40 bg-amber-950/30 text-amber-200'
            : 'border-gray-600/50 bg-gray-900/60 text-slate-300 hover:bg-gray-800'}"
        onclick={openAudioMenuFromButton}
        aria-expanded={audioMenuOpen}
        title={audioOutputMode === 'mute' ? 'Audio settings · Entire track muted' : 'Audio track settings'}
      >
        Audio
        {#if audioWaveformHidden}<span class="rounded bg-slate-400/15 px-1 text-[9px] uppercase">{audioWaveformGloballyHidden ? 'Globally hidden' : 'Hidden'}</span>{/if}
        {#if audioOutputMode === 'mute'}
          <span class="rounded bg-red-400/20 px-1 text-[9px] uppercase tracking-wide">Muted</span>
        {:else if audioDetached}
          <span class="rounded bg-amber-400/15 px-1 text-[9px] uppercase">Detached</span>
        {/if}
        <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m6 9 6 6 6-6" /></svg>
      </button>
    </div>
  </div>

  <div
    class="time-ruler relative h-6 cursor-ew-resize overflow-hidden border-x border-gray-700/20 bg-gray-950/35 text-[10px] tabular-nums text-slate-500"
    bind:clientWidth={timelineWidth}
    onwheel={handleTimelineWheel}
    aria-hidden="true"
  >
    {#each timelineTicks as tick}
      <span
        class="pointer-events-none absolute top-0 w-20 whitespace-nowrap"
        class:text-left={tick.percent < 5}
        class:text-center={tick.percent >= 5 && tick.percent <= 95}
        class:text-right={tick.percent > 95}
        style="left: {tick.percent < 5
          ? `${tick.percent}%`
          : tick.percent > 95
            ? `calc(${tick.percent}% - 5rem)`
            : `calc(${tick.percent}% - 2.5rem)`}"
      >{tick.label}</span>
      <span
        class="pointer-events-none absolute bottom-0 h-1.5 w-px bg-slate-500/70"
        style="left: {tick.percent}%"
      ></span>
    {/each}
  </div>

  <div
    class="timeline-container relative h-12 cursor-pointer overflow-hidden rounded-md border border-gray-700/20 bg-gray-950/70 shadow-inner"
    role="slider"
    tabindex="0"
    aria-label="Video timeline scrubber"
    aria-valuenow={Math.round(timelineUiTime)}
    aria-valuemin="0"
    aria-valuemax={Math.round(duration)}
    aria-valuetext={`${formatTimelineTime(timelineUiTime)}, ${viewportRange.zoom.toFixed(1)} times zoom`}
    onmousedown={(event) => {
      selectAudioMuteRange(null);
      onTimelineMouseDown(event);
    }}
    oncontextmenu={openAudioMenuAtPlayback}
    onwheel={handleTimelineWheel}
    onkeydown={onKeydown}
    title="Use the mouse wheel to zoom the timeline"
  >
    {#if playheadIsVisible}
      <div class="absolute top-0 z-30 h-full w-1 bg-red-500 shadow-lg" style="left: {playheadVisualLeft}">
        <div class="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 transform rounded-full bg-red-500 shadow-lg"></div>
      </div>
    {/if}

    {#each excludedTrimRanges as range}
      {@const visibleRange = getVisibleTimelineRange(range.startTime, range.endTime, timelineViewport, duration)}
      {#if visibleRange}
        <div
          class="video-trim-mask pointer-events-none absolute inset-y-0"
          style="left: {visibleRange.startPercent}%; width: {visibleRange.widthPercent}%"
        ></div>
      {/if}
    {/each}

    {#each trimRanges as range, index}
      {@const visibleRange = getVisibleTimelineRange(range.startTime, range.endTime, timelineViewport, duration)}
      {@const rangeStartPercent = timeToTimelinePercent(range.startTime, timelineViewport, duration)}
      {@const rangeEndPercent = timeToTimelinePercent(range.endTime, timelineViewport, duration)}
      {#if visibleRange}
        <div
          class="pointer-events-none absolute inset-y-0 z-10 border-y transition-colors {index === highlightedTrimRangeIndex ? 'border-sky-200/60 bg-sky-300/18' : 'border-slate-300/25 bg-slate-200/10'}"
          style="left: {visibleRange.startPercent}%; width: {visibleRange.widthPercent}%"
          title={`Kept section ${index + 1}: ${formatTimelineTime(range.startTime)} – ${formatTimelineTime(range.endTime)}`}
        ></div>
      {/if}
      {#if isTimeVisibleInTimeline(range.startTime, timelineViewport, duration)}
        <div class="pointer-events-none absolute inset-y-0 z-[11] w-px bg-teal-200/60" style="left: {rangeStartPercent}%"></div>
        <button
          type="button"
          class="trim-start-handle absolute top-0 z-20 h-full w-2 cursor-grab bg-teal-300 focus:outline-none focus-visible:outline-none {isDraggingStart && index === activeTrimRangeIndex ? 'cursor-grabbing' : ''}"
          style="left: {rangeStartPercent}%"
          role="slider"
          aria-label={`Start marker for kept section ${index + 1}`}
          aria-valuenow={Math.round(range.startTime * 1000)}
          onmousedown={(event) => {
            selectAudioMuteRange(null);
            selectTrimRange(index, false);
            onStartMarkerMouseDown(event);
          }}
          onkeydown={onKeydown}
        ></button>
      {/if}
      {#if isTimeVisibleInTimeline(range.endTime, timelineViewport, duration)}
        <div class="pointer-events-none absolute inset-y-0 z-[11] w-px bg-amber-200/60" style="left: {rangeEndPercent}%"></div>
        <button
          type="button"
          class="trim-end-handle absolute top-0 z-20 h-full w-2 cursor-grab bg-amber-400 focus:outline-none focus-visible:outline-none {isDraggingEnd && index === activeTrimRangeIndex ? 'cursor-grabbing' : ''}"
          style="left: calc({rangeEndPercent}% - 1px)"
          role="slider"
          aria-label={`End marker for kept section ${index + 1}`}
          aria-valuenow={Math.round(range.endTime * 1000)}
          onmousedown={(event) => {
            selectAudioMuteRange(null);
            selectTrimRange(index, false);
            onEndMarkerMouseDown(event);
          }}
          onkeydown={onKeydown}
        ></button>
      {/if}
    {/each}
  </div>

  {#if !audioWaveformHidden}
    <section
      class="audio-lane focus:outline-none relative mt-2 overflow-hidden rounded-md border transition-all {audioDetached
        ? 'border-amber-300/50 bg-amber-950/30 shadow-[0_0_0_1px_rgba(251,191,36,0.08)]'
        : 'border-cyan-300/35 bg-cyan-950/35 shadow-[0_0_0_1px_rgba(103,232,249,0.06)]'} {audioOutputMode === 'mute' ? 'audio-lane-muted shadow-[0_0_0_1px_rgba(248,113,113,0.12)]' : ''}"
      aria-label={audioOutputMode === 'mute' ? 'Entire audio track muted' : audioDetached ? 'Detached audio track' : 'Attached audio waveform'}
      oncontextmenu={openAudioMenu}
      onwheel={handleTimelineWheel}
    >
      <div class="relative h-14 rounded-md" bind:this={waveformTrack}>
      {#if audioOutputMode === 'mute'}
        <div class="audio-mute-overlay pointer-events-none absolute inset-0 z-20"></div>
        <div class="pointer-events-none absolute right-2 top-1.5 z-40 flex items-center gap-1.5 rounded border border-red-300/35 bg-red-950/90 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-red-100 shadow-md">
          <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5 6 9H3v6h3l5 4V5Zm8 4-6 6m0-6 6 6" />
          </svg>
          Entire track muted
        </div>
      {/if}
      {#each trimRanges as range}
        {@const visibleRange = getVisibleTimelineRange(range.startTime, range.endTime, timelineViewport, duration)}
        {#if visibleRange}
          <div
            class="pointer-events-none absolute inset-y-0 border-x {audioDetached ? 'border-amber-200/20 bg-amber-300/[0.06]' : 'border-cyan-200/20 bg-cyan-300/[0.06]'}"
            style="left: {visibleRange.startPercent}%; width: {visibleRange.widthPercent}%"
          ></div>
        {/if}
      {/each}
      <div class="pointer-events-none absolute inset-x-0 bottom-0 h-px {audioDetached ? 'bg-amber-200/20' : 'bg-cyan-200/20'}"></div>

      {#each audioMuteRanges as range, index}
        {@const displayedRange = muteRangeDrag?.index === index ? muteRangeDrag.previewRange : range}
        {@const visibleRange = getVisibleTimelineRange(displayedRange.startTime, displayedRange.endTime, timelineViewport, duration)}
        {#if visibleRange}
          <div
            class="absolute inset-y-0 z-30 border-x border-red-200/80 bg-red-500/30 shadow-[0_0_8px_rgba(248,113,113,0.25)]"
            class:ring-1={muteRangeDrag?.index === index || selectedAudioMuteRangeIndex === index}
            class:ring-red-200={muteRangeDrag?.index === index || selectedAudioMuteRangeIndex === index}
            style="left: {visibleRange.startPercent}%; width: {visibleRange.widthPercent}%"
            title={`Muted ${formatTimelineTime(displayedRange.startTime)} – ${formatTimelineTime(displayedRange.endTime)}`}
          >
            <button
              type="button"
              class="absolute inset-y-0 left-1.5 right-1.5 cursor-move touch-none focus:outline-none"
              aria-label={`Move muted portion ${index + 1}`}
              onpointerdown={(event) => beginMuteRangeDrag(event, index, 'move')}
            ></button>
            {#if isTimeVisibleInTimeline(displayedRange.startTime, timelineViewport, duration)}
              <button
                type="button"
                class="absolute inset-y-0 -left-1 z-10 w-3 cursor-ew-resize touch-none border-l-2 border-red-100/90 bg-gradient-to-r from-red-200/30 to-transparent focus:outline-none"
                aria-label={`Adjust start of muted portion ${index + 1}`}
                onpointerdown={(event) => beginMuteRangeDrag(event, index, 'start')}
              ></button>
            {/if}
            {#if isTimeVisibleInTimeline(displayedRange.endTime, timelineViewport, duration)}
              <button
                type="button"
                class="absolute inset-y-0 -right-1 z-10 w-3 cursor-ew-resize touch-none border-r-2 border-red-100/90 bg-gradient-to-l from-red-200/30 to-transparent focus:outline-none"
                aria-label={`Adjust end of muted portion ${index + 1}`}
                onpointerdown={(event) => beginMuteRangeDrag(event, index, 'end')}
              ></button>
            {/if}
          </div>
        {/if}
      {/each}

      {#if waveformLoading}
        <div class="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/10 to-transparent"></div>
      {:else if waveformHasAudio === false}
        <div class="absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-wider text-slate-500">No audio track</div>
      {:else if displayWaveformPeaks.length > 0}
        <svg class="absolute inset-0 z-10 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path
            d={waveformPath}
            fill="none"
            stroke={audioDetached ? '#fde68a' : '#a5f3fc'}
            stroke-opacity={audioOutputMode === 'mute' ? 0.45 : 0.9}
            stroke-width="1.35"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
        </svg>
      {/if}

      {#each excludedTrimRanges as range}
        {@const visibleRange = getVisibleTimelineRange(range.startTime, range.endTime, timelineViewport, duration)}
        {#if visibleRange}
          <div
            class="audio-trim-mask pointer-events-none absolute top-0 z-[5] h-full"
            style="left: {visibleRange.startPercent}%; width: {visibleRange.widthPercent}%"
          ></div>
        {/if}
      {/each}
      {#if playheadIsVisible}
        <div class="pointer-events-none absolute top-0 z-30 h-full w-px bg-red-300/95 shadow-[0_0_4px_rgba(252,165,165,0.6)]" style="left: {playheadVisualLeft}"></div>
      {/if}
      </div>
    </section>
  {/if}

  {#if viewportRange.zoom > 1}
    <div class="mt-2 flex items-center gap-2" role="group" aria-label="Timeline navigation">
      <span class="shrink-0 text-[10px] font-medium uppercase tracking-wider text-slate-600">View</span>
      <input
        class="timeline-pan-slider min-w-0 flex-1"
        class:audio-detached={audioDetached}
        type="range"
        tabindex="-1"
        min="0"
        max={maximumViewportStart}
        step="any"
        value={viewportRange.startTime}
        bind:clientWidth={timelinePanWidth}
        style={`--timeline-thumb-width: ${viewportThumbWidth}px`}
        aria-label="Move visible timeline window"
        aria-valuetext={`Viewing ${formatTimelineTime(viewportRange.startTime)} to ${formatTimelineTime(viewportRange.endTime)}`}
        oninput={handleTimelinePanInput}
        onchange={releaseTimelinePanFocus}
        onpointerup={releaseTimelinePanFocus}
        onpointercancel={releaseTimelinePanFocus}
      />
      <span class="w-24 shrink-0 text-right text-[10px] tabular-nums text-slate-500">{formatTimelineTime(viewportRange.startTime)}</span>
    </div>
  {/if}

</div>

<dialog
  bind:this={audioMenuDialog}
  class="fixed focus:outline-none z-[81] m-0 w-72 overflow-y-auto rounded-xl border border-gray-600/60 bg-gray-900/98 p-3 text-left text-white shadow-2xl shadow-black/50 backdrop-blur-md"
  style="left: {audioMenuX}px; top: {audioMenuY}px; right: auto; bottom: auto; max-height: calc(100vh - 16px)"
  aria-label="Audio track settings"
  oncancel={(event) => {
    event.preventDefault();
    closeAudioMenu();
  }}
  onclose={() => (audioMenuOpen = false)}
  onclick={closeAudioMenuFromBackdrop}
>
  {#if audioMenuOpen}
    <div class="mb-3 flex items-center justify-between gap-2">
      <div>
        <div class="text-sm font-semibold text-white">Audio track</div>
        <div class="text-[11px] text-slate-500">Timeline display and output audio.</div>
      </div>
      <button class="rounded p-1 text-slate-400 hover:bg-gray-800 hover:text-white" onclick={closeAudioMenu} aria-label="Close audio menu">✕</button>
    </div>

    <button
      type="button"
      class="mb-2 focus:outline-none w-full rounded-lg border border-gray-700 bg-gray-950/40 px-3 py-2 text-left text-sm text-slate-200 hover:bg-gray-800"
      onclick={() => setAudioWaveformsHidden(!audioWaveformGloballyHidden)}
    >
      <span class="block font-medium">{audioWaveformGloballyHidden ? 'Show waveforms on all tracks' : 'Hide waveforms on all tracks'}</span>
      <span class="mt-0.5 block text-[11px] opacity-65">Global timeline display setting.</span>
    </button>

    <button
      type="button"
      class="mb-2 focus:outline-none w-full rounded-lg border border-gray-700 bg-gray-950/40 px-3 py-2 text-left text-sm text-slate-200 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-55"
      onclick={() => setAudioWaveformHidden(!audioWaveformHidden)}
      disabled={audioWaveformGloballyHidden}
    >
      <span class="block font-medium">{audioWaveformGloballyHidden ? 'Waveforms hidden globally' : audioWaveformHidden ? 'Show audio waveform' : 'Hide audio waveform'}</span>
      <span class="mt-0.5 block text-[11px] opacity-65">{audioWaveformGloballyHidden ? 'Use the global control above to show waveforms.' : audioWaveformHidden ? 'Restore this track’s audio lane.' : 'Remove this track’s audio lane.'}</span>
    </button>

    <button
      type="button"
      class="mb-3 w-full rounded-lg border px-3 py-2 text-left text-sm {audioDetached ? 'border-amber-400/30 bg-amber-950/20 text-amber-200' : 'border-gray-700 bg-gray-950/40 text-slate-200 hover:bg-gray-800'}"
      onclick={toggleAudioDetached}
      disabled={waveformHasAudio === false}
    >
      <span class="block font-medium">{audioDetached ? 'Attach audio to video' : 'Detach audio'}</span>
      <span class="mt-0.5 block text-[11px] opacity-65">{audioDetached ? 'Return to a single linked video lane.' : 'Create a separate editable audio lane.'}</span>
    </button>

    <div class="focus:outline-none grid grid-cols-2 gap-1.5">
      <button class="rounded-md px-2 py-2 text-xs {audioOutputMode === 'keep' ? 'bg-slate-600 text-white' : 'bg-gray-800/70 text-slate-300 hover:bg-gray-700'}" onclick={() => chooseAudioMode('keep')}>Keep audio</button>
      <button class="rounded-md px-2 py-2 text-xs {audioOutputMode === 'mute' ? 'bg-red-900/70 text-red-100' : 'bg-gray-800/70 text-slate-300 hover:bg-gray-700'}" onclick={() => chooseAudioMode(audioOutputMode === 'mute' ? 'keep' : 'mute')}>Mute</button>
      <button class="col-span-2 rounded-md px-2 py-2 text-xs {audioOutputMode === 'extract' ? 'bg-amber-700/70 text-white' : 'bg-gray-800/70 text-slate-300 hover:bg-gray-700'}" onclick={() => chooseAudioMode(audioOutputMode === 'extract' ? 'keep' : 'extract')}>Extract audio only (.m4a)</button>
    </div>

    <div class="mt-3 border-t border-gray-700/70 pt-3">
      <div class="mb-2">
        <div class="text-xs font-semibold uppercase tracking-wide text-slate-300">Mute a portion</div>
        <div class="mt-0.5 text-[11px] text-slate-500">Right-click the video timeline to use the playhead as Start, then drag the red waveform bar or either edge. Select a muted portion and press Delete to remove it.</div>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <label class="text-[11px] text-slate-400">
          Start
          <input class="mt-1 w-full rounded border border-gray-700 bg-gray-950/60 px-2 py-1.5 text-xs text-white focus:border-red-400 focus:outline-none" bind:value={muteRangeStart} />
        </label>
        <label class="text-[11px] text-slate-400">
          End
          <input class="mt-1 w-full rounded border border-gray-700 bg-gray-950/60 px-2 py-1.5 text-xs text-white focus:border-red-400 focus:outline-none" bind:value={muteRangeEnd} />
        </label>
      </div>
      {#if muteRangeError}
        <div class="mt-2 text-[11px] text-red-300">{muteRangeError}</div>
      {/if}
      <button
        type="button"
        class="mt-2 w-full rounded-md bg-red-900/70 px-2 py-2 text-xs text-red-100 hover:bg-red-800/80 disabled:opacity-50"
        onclick={addAudioMuteRange}
        disabled={waveformHasAudio === false}
      >
        Add muted portion
      </button>

      {#if audioMuteRanges.length > 0}
        <div class="mt-2 max-h-24 space-y-1 overflow-auto">
          {#each audioMuteRanges as range, index}
            <div class="flex items-center justify-between gap-2 rounded bg-gray-950/45 px-2 py-1 text-[11px] text-slate-300">
              <button
                type="button"
                class="min-w-0 flex-1 rounded px-1 py-0.5 text-left focus:outline-none {selectedAudioMuteRangeIndex === index ? 'bg-red-950/70 text-red-100' : ''}"
                aria-pressed={selectedAudioMuteRangeIndex === index}
                onclick={() => selectAudioMuteRange(index)}
              >
                {formatTimelineTime(range.startTime)} – {formatTimelineTime(range.endTime)}
              </button>
              <button type="button" class="shrink-0 text-red-300 hover:text-red-200" onclick={() => removeAudioMuteRange(index)}>Remove</button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</dialog>

<style>
  .timeline-container {
    user-select: none;
    -webkit-user-select: none;
    outline: none !important;
  }

  .timeline-container:focus {
    outline: none !important;
    box-shadow: none !important;
  }

  .timeline-container > [role='slider'] {
    transform: translateX(-50%);
    cursor: grab;
  }

  .timeline-container > [role='slider']:active {
    cursor: grabbing;
  }

  .video-trim-mask {
    background-color: rgb(15 23 42 / 0.72);
    background-image: repeating-linear-gradient(
      -45deg,
      transparent,
      transparent 6px,
      rgb(148 163 184 / 0.08) 6px,
      rgb(148 163 184 / 0.08) 12px
    );
  }

  .trim-start-handle {
    border-radius: 0.45rem 0 0 0.45rem;
  }

  .trim-end-handle {
    border-radius: 0 0.45rem 0.45rem 0;
  }

  .audio-lane {
    background-image: linear-gradient(180deg, rgb(8 47 73 / 0.28), rgb(2 6 23 / 0.5));
  }

  .audio-lane-muted {
    border-color: rgb(248 113 113 / 0.6);
    background-image: linear-gradient(180deg, rgb(127 29 29 / 0.26), rgb(2 6 23 / 0.62));
  }

  .audio-mute-overlay {
    background-color: rgb(127 29 29 / 0.14);
    background-image: repeating-linear-gradient(
      -45deg,
      transparent,
      transparent 8px,
      rgb(248 113 113 / 0.08) 8px,
      rgb(248 113 113 / 0.08) 16px
    );
  }

  .audio-trim-mask {
    background-color: rgb(2 6 23 / 0.42);
  }

  .timeline-pan-slider {
    height: 1rem;
    cursor: ew-resize;
    appearance: none;
    outline: none;
    background: transparent;
  }

  .timeline-pan-slider::-webkit-slider-runnable-track {
    height: 0.45rem;
    border: 1px solid rgb(71 85 105 / 0.55);
    border-radius: 9999px;
    background: rgb(2 6 23 / 0.78);
    box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.45);
  }

  .timeline-pan-slider::-webkit-slider-thumb {
    width: var(--timeline-thumb-width);
    height: 0.7rem;
    margin-top: -0.2rem;
    appearance: none;
    border: 1px solid rgb(125 211 252 / 0.7);
    border-radius: 9999px;
    background: rgb(14 116 144 / 0.9);
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.55);
  }

  .timeline-pan-slider:hover::-webkit-slider-thumb {
    background: rgb(8 145 178 / 0.95);
  }

  .timeline-pan-slider.audio-detached::-webkit-slider-thumb {
    border-color: rgb(253 230 138 / 0.72);
    background: rgb(180 83 9 / 0.92);
  }

  .timeline-pan-slider.audio-detached:hover::-webkit-slider-thumb {
    background: rgb(217 119 6 / 0.96);
  }

  .timeline-pan-slider::-moz-range-track {
    height: 0.45rem;
    border: 1px solid rgb(71 85 105 / 0.55);
    border-radius: 9999px;
    background: rgb(2 6 23 / 0.78);
    box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.45);
  }

  .timeline-pan-slider::-moz-range-thumb {
    width: var(--timeline-thumb-width);
    height: 0.7rem;
    border: 1px solid rgb(125 211 252 / 0.7);
    border-radius: 9999px;
    background: rgb(14 116 144 / 0.9);
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.55);
  }

  .timeline-pan-slider.audio-detached::-moz-range-thumb {
    border-color: rgb(253 230 138 / 0.72);
    background: rgb(180 83 9 / 0.92);
  }

  .timeline-pan-slider.audio-detached:hover::-moz-range-thumb {
    background: rgb(217 119 6 / 0.96);
  }

  dialog::backdrop {
    background: transparent;
  }
</style>
