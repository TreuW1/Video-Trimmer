import type { CompressionPreset, VideoTrack } from '$lib/types/editor';
import { parseTime } from '$lib/utils/time';

export function calculateExpectedOutputSize(options: {
  tracks: VideoTrack[];
  activeTrackId: string | null;
  startTimeSeconds: number;
  endTimeSeconds: number;
  duration: number;
  selectedCompressionMode: string;
  compressionPresets: CompressionPreset[];
}): string {
  const {
    tracks,
    activeTrackId,
    startTimeSeconds,
    endTimeSeconds,
    duration,
    selectedCompressionMode,
    compressionPresets
  } =
    options;
  const selectedPreset = compressionPresets.find((preset) => preset.id === selectedCompressionMode);
  const selectedTracks = tracks.filter((track) => track.selected);

  function applyPresetEstimate(sizeMB: number): string {
    if (!selectedPreset) return `~${sizeMB.toFixed(1)} MB`;
    if (selectedPreset.processingStrategy === 'sizeTarget') {
      return selectedPreset.sizeLabel ?? `~${selectedPreset.sizeLimitMB ?? selectedPreset.targetSizeMB} MB`;
    }
    if (
      selectedPreset.processingStrategy === 'bitrateTarget' &&
      typeof selectedPreset.targetSizePercent === 'number'
    ) {
      return `~${(sizeMB * (selectedPreset.targetSizePercent / 100)).toFixed(1)} MB`;
    }
    return `~${sizeMB.toFixed(1)} MB`;
  }

  if (selectedTracks.length > 1) {
    let totalEstimatedSize = 0;
    let hasValidTracks = true;

    for (const track of selectedTracks) {
      const fileSize = track.videoFile?.size ?? track.fileSizeBytes ?? 0;
      if (fileSize <= 0) {
        hasValidTracks = false;
        break;
      }

      const trackStartSeconds = parseTime(track.startTime);
      const trackEndSeconds = parseTime(track.endTime);

      if (isNaN(trackStartSeconds) || isNaN(trackEndSeconds) || trackEndSeconds <= trackStartSeconds) {
        hasValidTracks = false;
        break;
      }

      const trimDurationSeconds = trackEndSeconds - trackStartSeconds;
      let originalDurationSeconds = track.duration;
      if (originalDurationSeconds <= 0) {
        originalDurationSeconds = (fileSize * 8) / (8 * 1024 * 1024);
      }

      const sizeReductionFactor =
        originalDurationSeconds > 0 ? trimDurationSeconds / originalDurationSeconds : 1;
      let trackEstimatedSize = (fileSize * sizeReductionFactor) / (1024 * 1024);

      if (selectedPreset?.processingStrategy === 'sizeTarget') {
        return selectedPreset.sizeLabel ?? `~${selectedPreset.sizeLimitMB ?? selectedPreset.targetSizeMB} MB`;
      }

      if (
        selectedPreset?.processingStrategy === 'bitrateTarget' &&
        typeof selectedPreset.targetSizePercent === 'number'
      ) {
        trackEstimatedSize *= selectedPreset.targetSizePercent / 100;
      }

      totalEstimatedSize += trackEstimatedSize;
    }

    return hasValidTracks ? `~${totalEstimatedSize.toFixed(1)} MB` : '';
  }

  if (!activeTrackId || startTimeSeconds === undefined || endTimeSeconds === undefined) {
    return '';
  }

  const activeTrack = tracks.find((track) => track.id === activeTrackId);
  if (!activeTrack || (!activeTrack.videoFile && !activeTrack.filePath)) {
    return '';
  }

  const trimDurationSeconds = endTimeSeconds - startTimeSeconds;
  const originalDurationSeconds = duration;
  if (originalDurationSeconds <= 0) {
    return '';
  }

  const sizeReductionFactor = trimDurationSeconds / originalDurationSeconds;
  const fileSize = activeTrack.videoFile?.size ?? activeTrack.fileSizeBytes ?? 0;
  if (fileSize === 0) {
    return '';
  }

  let estimatedSize = (fileSize * sizeReductionFactor) / (1024 * 1024);

  return applyPresetEstimate(estimatedSize);
}
