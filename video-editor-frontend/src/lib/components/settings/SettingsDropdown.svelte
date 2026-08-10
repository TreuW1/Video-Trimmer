<script lang="ts">
  import { onMount } from 'svelte';
  import DropdownSetting from './DropdownSetting.svelte';

  let {
    outputDirectory,
    generateOutputFilename,
    hardwareAccelerationEnabled,
    chooseOutputDirectory,
    clearOutputDirectory,
    setGenerateOutputFilename,
    setHardwareAccelerationEnabled,
    openCompressionPresetModal
  }: {
    outputDirectory: string;
    generateOutputFilename: boolean;
    hardwareAccelerationEnabled: boolean;
    chooseOutputDirectory: () => void;
    clearOutputDirectory: () => void;
    setGenerateOutputFilename: (enabled: boolean) => void;
    setHardwareAccelerationEnabled: (enabled: boolean) => void;
    openCompressionPresetModal: () => void;
  } = $props();

  let isOpen = $state(false);
  let rootElement = $state<HTMLElement | null>(null);

  onMount(() => {
    const handleDocumentClick = (event: MouseEvent) => {
      if (!rootElement?.contains(event.target as Node)) {
        isOpen = false;
      }
    };

    document.addEventListener('click', handleDocumentClick);

    return () => {
      document.removeEventListener('click', handleDocumentClick);
    };
  });
</script>

<div class="relative shrink-0" bind:this={rootElement}>
  <button
    type="button"
    class="rounded-lg border border-gray-600/50 bg-slate-700/60 px-3 py-1.5 text-sm font-medium text-slate-200 transition-all duration-200 hover:bg-slate-600/80 focus:outline-none"
    aria-haspopup="menu"
    aria-expanded={isOpen}
    onclick={() => {
      isOpen = !isOpen;
    }}
  >
    Settings
  </button>

  {#if isOpen}
    <div
      class="absolute left-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-700/40 bg-gray-900/95 p-2 shadow-2xl backdrop-blur"
      role="menu"
    >
      <DropdownSetting
        title="Output"
        value={outputDirectory}
        fallbackValue="Default outputs folder"
        description="Use the app's default outputs folder or choose a custom folder."
      >
        <div class="grid grid-cols-2 gap-2">
          <button
            type="button"
            onclick={chooseOutputDirectory}
            class="rounded-lg border border-slate-500/40 bg-slate-700/50 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-slate-600/60"
          >
            Choose
          </button>
          <button
            type="button"
            onclick={clearOutputDirectory}
            disabled={!outputDirectory}
            class="rounded-lg border border-gray-600/40 bg-gray-800/50 px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-gray-700/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Default
          </button>
        </div>
        <label class="mt-3 flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-gray-700/40 bg-gray-800/40 p-3">
          <span class="min-w-0">
            <span class="block text-sm font-medium text-slate-200">Generate file names</span>
            <span class="mt-1 block text-xs text-slate-500">
              {generateOutputFilename
                ? 'Use a unique timestamped name automatically.'
                : 'Ask for a new file name before every trim.'}
            </span>
          </span>
          <input
            type="checkbox"
            checked={generateOutputFilename}
            onchange={(event) => setGenerateOutputFilename(event.currentTarget.checked)}
            class="mt-1 rounded border-gray-600 bg-gray-800 text-slate-500 focus:ring-slate-500"
          />
        </label>
      </DropdownSetting>

      <DropdownSetting
        title="Compression presets"
        value="Custom modes"
        description="Create encoder presets for the compression list."
      >
        <button
          type="button"
          onclick={() => {
            isOpen = false;
            openCompressionPresetModal();
          }}
          class="w-full rounded-lg border border-slate-500/40 bg-slate-700/50 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-slate-600/60"
        >
          Custom compression modes
        </button>
      </DropdownSetting>

      <DropdownSetting
        title="Hardware acceleration"
        value={hardwareAccelerationEnabled ? 'Enabled' : 'Disabled'}
        description="Use GPU encoding when supported."
      >
        <label class="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-gray-700/40 bg-gray-800/40 p-3">
          <span class="min-w-0">
            <span class="block text-sm font-medium text-slate-200">GPU processing</span>
            <span class="mt-1 block text-xs text-slate-500">
              Faster H.264, HEVC, and AV1 compression on supported NVIDIA hardware.
            </span>
          </span>
          <input
            type="checkbox"
            class="peer sr-only"
            checked={hardwareAccelerationEnabled}
            onchange={(event) => {
              setHardwareAccelerationEnabled((event.currentTarget as HTMLInputElement).checked);
            }}
          />
          <span
            class="relative h-6 w-11 shrink-0 rounded-full bg-gray-700 transition-colors after:absolute after:left-1 after:top-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-slate-500 peer-checked:after:translate-x-5"
            aria-hidden="true"
          ></span>
        </label>
      </DropdownSetting>
    </div>
  {/if}
</div>
