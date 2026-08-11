<script lang="ts">
  import { onMount } from 'svelte';
  import { API_BASE, apiFetch } from '$lib/backendApi';
  import appPackage from '../../../../package.json';
  import DropdownSetting from './DropdownSetting.svelte';

  type UpdateResult = {
    currentVersion: string;
    latestVersion: string;
    updateAvailable: boolean;
    releaseUrl: string;
    releaseName: string;
    publishedAt: string | null;
  };

  let {
    outputDirectory,
    generateOutputFilename,
    hardwareAccelerationEnabled,
    popupNotificationsEnabled,
    chooseOutputDirectory,
    clearOutputDirectory,
    setGenerateOutputFilename,
    setHardwareAccelerationEnabled,
    setPopupNotificationsEnabled,
    openCompressionPresetModal
  }: {
    outputDirectory: string;
    generateOutputFilename: boolean;
    hardwareAccelerationEnabled: boolean;
    popupNotificationsEnabled: boolean;
    chooseOutputDirectory: () => void;
    clearOutputDirectory: () => void;
    setGenerateOutputFilename: (enabled: boolean) => void;
    setHardwareAccelerationEnabled: (enabled: boolean) => void;
    setPopupNotificationsEnabled: (enabled: boolean) => void;
    openCompressionPresetModal: () => void;
  } = $props();

  let isOpen = $state(false);
  let rootElement = $state<HTMLElement | null>(null);
  let updateState = $state<'idle' | 'checking' | 'current' | 'available' | 'error'>('idle');
  let updateResult = $state<UpdateResult | null>(null);
  let updateError = $state('');

  async function checkForUpdates(): Promise<void> {
    updateState = 'checking';
    updateResult = null;
    updateError = '';

    try {
      const response = await apiFetch(`${API_BASE}/update-check`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not check for updates.');

      updateResult = data as UpdateResult;
      updateState = updateResult.updateAvailable ? 'available' : 'current';
    } catch (error) {
      updateError = error instanceof Error ? error.message : 'Could not check for updates.';
      updateState = 'error';
    }
  }

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
        title="Pop-up notifications"
        value={popupNotificationsEnabled ? 'Enabled' : 'Disabled'}
        description="Show status messages and upload progress over the editor."
      >
        <label class="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-gray-700/40 bg-gray-800/40 p-3">
          <span class="min-w-0">
            <span class="block text-sm font-medium text-slate-200">Editor pop-ups</span>
            <span class="mt-1 block text-xs text-slate-500">
              Includes confirmations, errors, and the upload queue.
            </span>
          </span>
          <input
            type="checkbox"
            class="peer sr-only"
            checked={popupNotificationsEnabled}
            onchange={(event) => {
              setPopupNotificationsEnabled((event.currentTarget as HTMLInputElement).checked);
            }}
          />
          <span
            class="relative h-6 w-11 shrink-0 rounded-full bg-gray-700 transition-colors after:absolute after:left-1 after:top-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-slate-500 peer-checked:after:translate-x-5"
            aria-hidden="true"
          ></span>
        </label>
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

      <DropdownSetting
        title="Updates"
        value={`Version ${appPackage.version}`}
        description="Check GitHub for a newer published release."
      >
        <div class="space-y-2" aria-live="polite">
          <button
            type="button"
            onclick={checkForUpdates}
            disabled={updateState === 'checking'}
            class="w-full rounded-lg border border-slate-500/40 bg-slate-700/50 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-slate-600/60 disabled:cursor-wait disabled:opacity-60"
          >
            {updateState === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>

          {#if updateState === 'available' && updateResult}
            <div class="rounded-lg border border-emerald-700/40 bg-emerald-950/30 p-3 text-xs text-emerald-200">
              <p>Version {updateResult.latestVersion} is available.</p>
              <a
                href={updateResult.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="mt-2 inline-block font-medium text-emerald-300 underline decoration-emerald-600 underline-offset-2 hover:text-emerald-200"
              >
                View release and download
              </a>
            </div>
          {:else if updateState === 'current' && updateResult}
            <p class="rounded-lg border border-gray-700/40 bg-gray-800/40 p-3 text-xs text-slate-300">
              You're up to date. The latest release is version {updateResult.latestVersion}.
            </p>
          {:else if updateState === 'error'}
            <p class="rounded-lg border border-red-800/40 bg-red-950/30 p-3 text-xs text-red-300">
              {updateError}
            </p>
          {/if}
        </div>
      </DropdownSetting>
    </div>
  {/if}
</div>
