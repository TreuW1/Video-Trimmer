<script lang="ts">
  import { onMount } from 'svelte';

  const MIN_SPEED = 0.25;
  const MAX_SPEED = 2;
  const SPEED_STEP = 0.05;
  const QUICK_SPEEDS = Array.from({ length: 8 }, (_, index) => (index + 1) * 0.25);

  let {
    speed,
    disabled = false,
    onSpeedChange,
    onTogglePlayback
  }: {
    speed: number;
    disabled?: boolean;
    onSpeedChange: (speed: number) => void;
    onTogglePlayback: () => void;
  } = $props();

  let isOpen = $state(false);
  let rootElement = $state<HTMLElement | null>(null);
  let sliderFill = $derived(((speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)) * 100);

  function formatSpeed(value: number): string {
    return Number.isInteger(value * 10) ? value.toFixed(1) : value.toFixed(2);
  }

  function selectSpeed(value: number): void {
    const stepped = Math.round(value / SPEED_STEP) * SPEED_STEP;
    onSpeedChange(Math.max(MIN_SPEED, Math.min(MAX_SPEED, stepped)));
  }

  function handleSliderInput(event: Event): void {
    selectSpeed((event.currentTarget as HTMLInputElement).valueAsNumber);
  }

  function handleMenuKeydown(event: KeyboardEvent): void {
    if (event.code !== 'Space') return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) onTogglePlayback();
  }

  function handleTriggerKeydown(event: KeyboardEvent): void {
    if (isOpen) handleMenuKeydown(event);
  }

  $effect(() => {
    if (disabled) isOpen = false;
  });

  onMount(() => {
    const handleDocumentClick = (event: MouseEvent) => {
      if (!rootElement?.contains(event.target as Node)) isOpen = false;
    };

    const handleDocumentKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') isOpen = false;
    };

    document.addEventListener('click', handleDocumentClick);
    document.addEventListener('keydown', handleDocumentKeydown);

    return () => {
      document.removeEventListener('click', handleDocumentClick);
      document.removeEventListener('keydown', handleDocumentKeydown);
    };
  });
</script>

<div class="relative shrink-0" bind:this={rootElement}>
  <button
    type="button"
    class="flex h-8 min-w-14 items-center justify-center rounded-full border border-gray-500/30 bg-gray-600/60 px-2.5 text-xs font-semibold tabular-nums text-slate-200 transition-colors hover:bg-gray-500/60 hover:text-white focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50"
    disabled={disabled}
    aria-label={`Playback speed ${formatSpeed(speed)} times`}
    aria-haspopup="dialog"
    aria-expanded={isOpen}
    title="Playback speed"
    onclick={() => {
      isOpen = !isOpen;
    }}
    onkeydown={handleTriggerKeydown}
  >
    {formatSpeed(speed)}×
  </button>

  {#if isOpen}
    <div
      class="absolute bottom-full left-0 z-50 mb-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-600/60 bg-gray-900/95 p-4 shadow-2xl outline-none backdrop-blur focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
      role="dialog"
      aria-label="Playback speed"
      tabindex="-1"
      onkeydown={handleMenuKeydown}
    >
      <div class="mb-3 flex items-center justify-between gap-3">
        <span class="text-sm font-medium text-slate-200">Playback speed</span>
        <span class="rounded-md bg-slate-700/70 px-2 py-1 text-xs font-semibold tabular-nums text-white">
          {formatSpeed(speed)}×
        </span>
      </div>

      <label class="block">
        <span class="sr-only">Choose playback speed</span>
        <input
          class="playback-speed-slider w-full focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
          type="range"
          min={MIN_SPEED}
          max={MAX_SPEED}
          step={SPEED_STEP}
          value={speed}
          style={`--speed-fill: ${sliderFill}%`}
          aria-valuetext={`${formatSpeed(speed)} times`}
          oninput={handleSliderInput}
        />
      </label>
      <div class="mt-1 flex justify-between text-[10px] tabular-nums text-slate-500" aria-hidden="true">
        <span>0.25×</span>
        <span>1.0×</span>
        <span>2.0×</span>
      </div>

      <div class="mt-4 grid grid-cols-4 gap-1.5" aria-label="Quick playback speeds">
        {#each QUICK_SPEEDS as quickSpeed}
          <button
            type="button"
            class="rounded-md border px-1.5 py-1.5 text-[11px] font-medium tabular-nums transition-colors focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 {Math.abs(speed - quickSpeed) < SPEED_STEP / 2
              ? 'border-slate-400/70 bg-slate-600 text-white'
              : 'border-slate-700/70 bg-slate-800/70 text-slate-300 hover:border-slate-500 hover:bg-slate-700/80'}"
            aria-pressed={Math.abs(speed - quickSpeed) < SPEED_STEP / 2}
            onclick={() => selectSpeed(quickSpeed)}
          >
            {quickSpeed.toFixed(2)}×
          </button>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .playback-speed-slider {
    height: 18px;
    appearance: none;
    cursor: pointer;
    background: transparent;
  }

  .playback-speed-slider::-webkit-slider-runnable-track {
    height: 5px;
    border-radius: 9999px;
    background: linear-gradient(
      to right,
      rgb(203 213 225) var(--speed-fill),
      rgb(51 65 85) var(--speed-fill)
    );
  }

  .playback-speed-slider::-webkit-slider-thumb {
    width: 16px;
    height: 16px;
    margin-top: -5.5px;
    appearance: none;
    border: 2px solid rgb(15 23 42);
    border-radius: 9999px;
    background: white;
    box-shadow: 0 1px 5px rgb(0 0 0 / 0.45);
  }

  .playback-speed-slider:hover::-webkit-slider-thumb {
    background: rgb(226 232 240);
  }

  .playback-speed-slider:focus,
  .playback-speed-slider:focus-visible {
    outline: none;
    box-shadow: none;
  }

  .playback-speed-slider::-moz-range-track {
    height: 5px;
    border-radius: 9999px;
    background: rgb(51 65 85);
  }

  .playback-speed-slider::-moz-range-progress {
    height: 5px;
    border-radius: 9999px;
    background: rgb(203 213 225);
  }

  .playback-speed-slider::-moz-range-thumb {
    width: 13px;
    height: 13px;
    border: 2px solid rgb(15 23 42);
    border-radius: 9999px;
    background: white;
    box-shadow: 0 1px 5px rgb(0 0 0 / 0.45);
  }
</style>
