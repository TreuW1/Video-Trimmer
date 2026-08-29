<script lang="ts">
  import type { CompressionPreset } from '$lib/types/editor';

  type PresetDraft = CompressionPreset;

  let {
    open,
    editingPreset = null,
    saving = false,
    error = '',
    onClose,
    onSave
  }: {
    open: boolean;
    editingPreset?: CompressionPreset | null;
    saving?: boolean;
    error?: string;
    onClose: () => void;
    onSave: (preset: CompressionPreset) => void | Promise<void>;
  } = $props();

  const blankPreset = (): PresetDraft => ({
    id: '',
    name: '',
    description: '',
    processingStrategy: 'manual',
    rateControl: 'targetSize',
    videoCodec: 'libx264',
    audioCodec: 'aac',
    options: [],
    extraOptions: [],
    targetSizePercent: 50,
    targetSizeMB: 18.5,
    sizeLimitMB: 20,
    sizeLabel: '',
    bitrateKbps: 8000,
    maxrateKbps: null,
    bufsizeKbps: null,
    audioBitrateKbps: 128,
    crf: 24,
    qp: 24,
    width: null,
    height: null,
    fps: null,
    encoderPreset: 'medium',
    profile: 'main',
    level: '4.2',
    tune: '',
    pixelFormat: 'yuv420p',
    audioSampleRate: null,
    audioChannels: null,
    alwaysCompress: false,
    estimatedTime: 'Custom',
    qualityLevel: 'Custom',
    builtIn: false
  });

  let draft = $state<PresetDraft>(blankPreset());
  let extraOptionsText = $state('');

  let bitrateDisabled = $derived(draft.rateControl !== 'constantBitrate');
  let targetPercentActive = $derived(draft.rateControl === 'targetPercent');
  let targetSizeActive = $derived(draft.rateControl === 'targetSize');
  let crfActive = $derived(draft.rateControl === 'constantQuality');
  let qpActive = $derived(draft.rateControl === 'constantQp');
  let svtAv1Preset = $derived(draft.videoCodec === 'libsvtav1');

  const defaultEncoderPresetOptions = [
    { value: '', label: 'Default' },
    { value: 'ultrafast', label: 'Ultrafast' },
    { value: 'veryfast', label: 'Very fast' },
    { value: 'fast', label: 'Fast' },
    { value: 'medium', label: 'Medium' },
    { value: 'slow', label: 'Slow' },
    { value: 'veryslow', label: 'Very slow' }
  ];

  const svtAv1EncoderPresetOptions = [
    { value: '', label: 'Default' },
    { value: '4', label: 'AV1 slower' },
    { value: '6', label: 'AV1 quality' },
    { value: '8', label: 'AV1 balanced' },
    { value: '10', label: 'AV1 fast' },
    { value: '12', label: 'AV1 fastest' }
  ];

  let encoderPresetOptions = $derived(svtAv1Preset ? svtAv1EncoderPresetOptions : defaultEncoderPresetOptions);

  function numberOrNull(value: string): number | null {
    if (value.trim() === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function updateNumber(key: keyof CompressionPreset, value: string): void {
    draft = {
      ...draft,
      [key]: numberOrNull(value)
    };
  }

  function optionalNumberValue(value: number | null | undefined): string | number {
    return value && value > 0 ? value : '';
  }

  function applyRateControl(rateControl: CompressionPreset['rateControl']): void {
    const processingStrategy =
      rateControl === 'targetPercent'
        ? 'bitrateTarget'
        : rateControl === 'targetSize'
          ? 'sizeTarget'
          : 'manual';

    draft = {
      ...draft,
      rateControl,
      processingStrategy
    };
  }

  function applyVideoCodec(videoCodec: string): void {
    const currentPreset = draft.encoderPreset?.trim() ?? '';
    const nextPreset =
      videoCodec === 'libsvtav1'
        ? /^\d+$/.test(currentPreset)
          ? currentPreset
          : '8'
        : /^\d+$/.test(currentPreset)
          ? 'medium'
          : currentPreset;

    draft = {
      ...draft,
      videoCodec,
      encoderPreset: videoCodec === 'libaom-av1' || videoCodec === 'libaom-av2' ? '' : nextPreset,
      profile: videoCodec.includes('av1') || videoCodec.includes('av2') ? '' : draft.profile,
      level: videoCodec.includes('av1') || videoCodec.includes('av2') ? '' : draft.level,
      tune: videoCodec.includes('av1') || videoCodec.includes('av2') ? '' : draft.tune
    };
  }

  function submit(): void {
    const extraOptions = extraOptionsText
      .split('\n')
      .map((option) => option.trim())
      .filter(Boolean);

    onSave({
      ...draft,
      extraOptions,
      sizeLabel: draft.sizeLabel?.trim() || null,
      profile: draft.profile?.trim() || null,
      level: draft.level?.trim() || null,
      tune: draft.tune?.trim() || null,
      encoderPreset: draft.encoderPreset?.trim() || null,
      pixelFormat: draft.pixelFormat?.trim() || 'yuv420p'
    });
  }

  $effect(() => {
    if (!open) return;
    draft = editingPreset
      ? {
          ...blankPreset(),
          ...editingPreset,
          options: editingPreset.options ?? [],
          extraOptions: editingPreset.extraOptions ?? []
        }
      : blankPreset();
    extraOptionsText = (editingPreset?.extraOptions ?? []).join('\n');
  });
</script>

{#if open}
  <div class="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4" role="presentation">
    <div class="w-full max-w-3xl overflow-hidden rounded-lg border border-gray-700/60 bg-gray-950 shadow-2xl">
      <div class="flex items-center justify-between border-b border-gray-800 px-5 py-4">
        <div>
          <h2 class="text-base font-semibold text-white">{editingPreset ? 'Edit compression preset' : 'Create compression preset'}</h2>
          <p class="mt-1 text-xs text-slate-400">Blank resolution and FPS keep the source values.</p>
        </div>
        <button type="button" class="rounded-md px-2 py-1 text-sm text-slate-300 hover:bg-gray-800" onclick={onClose}>Close</button>
      </div>

      <div class="trimmer-scrollbar max-h-[75vh] overflow-auto p-5">
        <div class="grid gap-4 md:grid-cols-2">
          <label class="block">
            <span class="mb-1 block text-xs font-medium uppercase text-slate-400">Name</span>
            <input class="w-full rounded-md border-gray-700 bg-gray-900 text-sm text-white" bind:value={draft.name} placeholder="Discord 25MB H.265" />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium uppercase text-slate-400">Rate control</span>
            <select class="w-full rounded-md border-gray-700 bg-gray-900 text-sm text-white" value={draft.rateControl} onchange={(event) => applyRateControl((event.currentTarget as HTMLSelectElement).value as CompressionPreset['rateControl'])}>
              <option value="targetPercent">Percent reduction target</option>
              <option value="targetSize">Target MB</option>
              <option value="constantBitrate">Constant bitrate</option>
              <option value="constantQuality">Constant quality (CRF)</option>
              <option value="constantQp">Constant QP</option>
            </select>
          </label>
          <label class="block md:col-span-2">
            <span class="mb-1 block text-xs font-medium uppercase text-slate-400">Description</span>
            <textarea class="min-h-20 w-full rounded-md border-gray-700 bg-gray-900 text-sm text-white" bind:value={draft.description} placeholder="What this preset is for"></textarea>
          </label>
        </div>

        <div class="mt-5 grid gap-4 md:grid-cols-4">
          <label class="block">
            <span class="mb-1 block text-xs font-medium uppercase text-slate-400">Video codec</span>
            <select class="w-full rounded-md border-gray-700 bg-gray-900 text-sm text-white" value={draft.videoCodec} onchange={(event) => applyVideoCodec((event.currentTarget as HTMLSelectElement).value)}>
              <option value="libx264">H.264 / AVC</option>
              <option value="libx265">H.265 / HEVC</option>
              <option value="libsvtav1">AV1 / SVT-AV1</option>
              <option value="libaom-av1">AV1 / libaom</option>
              <option value="libaom-av2">AV2 / Experimental</option>
              <option value="copy">Copy video</option>
            </select>
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium uppercase text-slate-400">Encoder preset</span>
            <select class="w-full rounded-md border-gray-700 bg-gray-900 text-sm text-white" bind:value={draft.encoderPreset}>
              {#each encoderPresetOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium uppercase text-slate-400">Audio codec</span>
            <select class="w-full rounded-md border-gray-700 bg-gray-900 text-sm text-white" bind:value={draft.audioCodec}>
              <option value="aac">AAC</option>
              <option value="copy">Copy audio</option>
            </select>
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium uppercase text-slate-400">Audio kbps</span>
            <input class="w-full rounded-md border-gray-700 bg-gray-900 text-sm text-white disabled:opacity-45" type="number" min="16" disabled={draft.audioCodec === 'copy'} value={draft.audioBitrateKbps ?? ''} oninput={(event) => updateNumber('audioBitrateKbps', (event.currentTarget as HTMLInputElement).value)} />
          </label>
        </div>

        <div class="mt-5 grid gap-4 md:grid-cols-5">
          <label class="block">
            <span class="mb-1 block text-xs font-medium uppercase text-slate-400">% of source</span>
            <input class="w-full rounded-md border-gray-700 bg-gray-900 text-sm text-white disabled:opacity-45" type="number" min="1" max="100" disabled={!targetPercentActive} value={draft.targetSizePercent ?? ''} oninput={(event) => updateNumber('targetSizePercent', (event.currentTarget as HTMLInputElement).value)} />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium uppercase text-slate-400">Target MB</span>
            <input class="w-full rounded-md border-gray-700 bg-gray-900 text-sm text-white disabled:opacity-45" type="number" min="1" step="0.1" disabled={!targetSizeActive} value={draft.targetSizeMB ?? ''} oninput={(event) => updateNumber('targetSizeMB', (event.currentTarget as HTMLInputElement).value)} />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium uppercase text-slate-400">Limit MB</span>
            <input class="w-full rounded-md border-gray-700 bg-gray-900 text-sm text-white disabled:opacity-45" type="number" min="1" step="0.1" disabled={!targetSizeActive} value={draft.sizeLimitMB ?? ''} oninput={(event) => updateNumber('sizeLimitMB', (event.currentTarget as HTMLInputElement).value)} />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium uppercase text-slate-400">Bitrate kbps</span>
            <input class="w-full rounded-md border-gray-700 bg-gray-900 text-sm text-white disabled:opacity-45" type="number" min="50" disabled={bitrateDisabled} value={draft.bitrateKbps ?? ''} oninput={(event) => updateNumber('bitrateKbps', (event.currentTarget as HTMLInputElement).value)} />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium uppercase text-slate-400">CRF / QP</span>
            <input class="w-full rounded-md border-gray-700 bg-gray-900 text-sm text-white disabled:opacity-45" type="number" min="0" max="51" disabled={!crfActive && !qpActive} value={crfActive ? (draft.crf ?? '') : (draft.qp ?? '')} oninput={(event) => updateNumber(crfActive ? 'crf' : 'qp', (event.currentTarget as HTMLInputElement).value)} />
          </label>
        </div>

        <label class="mt-4 flex items-start gap-3 rounded-lg border border-gray-700/60 bg-gray-900/40 p-3 {targetSizeActive ? '' : 'opacity-45'}">
          <input
            type="checkbox"
            class="mt-0.5 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500"
            checked={draft.alwaysCompress ?? false}
            disabled={!targetSizeActive}
            onchange={(event) => {
              draft = { ...draft, alwaysCompress: event.currentTarget.checked };
            }}
          />
          <span>
            <span class="block text-sm font-medium text-slate-200">Always run compression for Target MB</span>
            <span class="mt-0.5 block text-xs text-slate-500">When selected compression will be ran regardless of initial size check.</span>
          </span>
        </label>

        <div class="mt-5 grid gap-4 md:grid-cols-4">
          <label class="block">
            <span class="mb-1 block text-xs font-medium uppercase text-slate-400">Width</span>
            <input class="w-full rounded-md border-gray-700 bg-gray-900 text-sm text-white" type="number" min="2" step="2" placeholder="Source" value={optionalNumberValue(draft.width)} oninput={(event) => updateNumber('width', (event.currentTarget as HTMLInputElement).value)} />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium uppercase text-slate-400">Height</span>
            <input class="w-full rounded-md border-gray-700 bg-gray-900 text-sm text-white" type="number" min="2" step="2" placeholder="Source" value={optionalNumberValue(draft.height)} oninput={(event) => updateNumber('height', (event.currentTarget as HTMLInputElement).value)} />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium uppercase text-slate-400">FPS</span>
            <input class="w-full rounded-md border-gray-700 bg-gray-900 text-sm text-white" type="number" min="1" step="0.01" placeholder="Source" value={optionalNumberValue(draft.fps)} oninput={(event) => updateNumber('fps', (event.currentTarget as HTMLInputElement).value)} />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium uppercase text-slate-400">Pixel format</span>
            <input class="w-full rounded-md border-gray-700 bg-gray-900 text-sm text-white" bind:value={draft.pixelFormat} placeholder="yuv420p" />
          </label>
        </div>

        <div class="mt-5 grid gap-4 md:grid-cols-3">
          <label class="block">
            <span class="mb-1 block text-xs font-medium uppercase text-slate-400">Profile</span>
            <input class="w-full rounded-md border-gray-700 bg-gray-900 text-sm text-white" bind:value={draft.profile} placeholder="main" />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium uppercase text-slate-400">Level</span>
            <input class="w-full rounded-md border-gray-700 bg-gray-900 text-sm text-white" bind:value={draft.level} placeholder="4.2" />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium uppercase text-slate-400">Tune</span>
            <input class="w-full rounded-md border-gray-700 bg-gray-900 text-sm text-white" bind:value={draft.tune} placeholder="film" />
          </label>
        </div>

        <label class="mt-5 block">
          <span class="mb-1 block text-xs font-medium uppercase text-slate-400">Extra ffmpeg options</span>
          <textarea class="min-h-20 w-full rounded-md border-gray-700 bg-gray-900 font-mono text-xs text-white" bind:value={extraOptionsText} placeholder="-tag:v hvc1&#10;-x265-params log-level=error"></textarea>
        </label>

        {#if error}
          <div class="mt-4 rounded-md border border-red-500/30 bg-red-950/40 px-3 py-2 text-sm text-red-200">{error}</div>
        {/if}
      </div>

      <div class="flex justify-end gap-2 border-t border-gray-800 px-5 py-4">
        <button type="button" class="rounded-md border border-gray-700 px-4 py-2 text-sm text-slate-200 hover:bg-gray-800" onclick={onClose}>Cancel</button>
        <button type="button" class="rounded-md bg-slate-200 px-4 py-2 text-sm font-semibold text-gray-950 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50" disabled={saving || !draft.name.trim()} onclick={submit}>
          {saving ? 'Saving...' : editingPreset ? 'Save preset' : 'Create preset'}
        </button>
      </div>
    </div>
  </div>
{/if}
