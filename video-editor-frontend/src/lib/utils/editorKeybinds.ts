export type EditorKeybindContext = {
  browser: boolean;
  controlsEnabled: boolean;
  overlaysOpen: boolean;
  isDraggingStart: boolean;
  isDraggingEnd: boolean;
  isTimelinePlayheadScrubbing: boolean;
};

export type EditorKeybindActions = {
  closeSidebarOverlays: () => void;
  navigateToLibrary: () => void;
  toggleFullscreen: () => void;
  setCurrentAsStart: () => void;
  setCurrentAsEnd: () => void;
  addTrimRange: () => void;
  deleteTimelineSelection: () => void;
  playFromStart: () => void;
  togglePlayback: () => void;
  stepFrame: (direction: -1 | 1) => void;
};

const EDITOR_SHORTCUT_CODES = new Set([
  'KeyS',
  'KeyE',
  'KeyT',
  'Delete',
  'KeyP',
  'Space',
  'ArrowLeft',
  'ArrowRight',
  'KeyF'
]);

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

export function handleEditorKeybind(
  event: KeyboardEvent,
  context: EditorKeybindContext,
  actions: EditorKeybindActions
): void {
  if (event.key === 'Escape' && context.overlaysOpen) {
    actions.closeSidebarOverlays();
    event.preventDefault();
    return;
  }

  if (event.ctrlKey && event.key === '1') {
    event.preventDefault();
    actions.navigateToLibrary();
    return;
  }

  if (event.ctrlKey && event.key === '2') {
    event.preventDefault();
    return;
  }

  if (
    !context.browser ||
    !context.controlsEnabled ||
    isEditableTarget(event.target) ||
    context.isDraggingStart ||
    context.isDraggingEnd ||
    context.isTimelinePlayheadScrubbing
  ) {
    return;
  }

  if (EDITOR_SHORTCUT_CODES.has(event.code)) {
    event.preventDefault();
    event.stopPropagation();
  }

  switch (event.code) {
    case 'KeyF':
      actions.toggleFullscreen();
      break;
    case 'KeyS':
      actions.setCurrentAsStart();
      break;
    case 'KeyE':
      actions.setCurrentAsEnd();
      break;
    case 'KeyT':
      actions.addTrimRange();
      break;
    case 'Delete':
      actions.deleteTimelineSelection();
      break;
    case 'KeyP':
      actions.playFromStart();
      break;
    case 'Space':
      actions.togglePlayback();
      break;
    case 'ArrowLeft':
      actions.stepFrame(-1);
      break;
    case 'ArrowRight':
      actions.stepFrame(1);
      break;
  }
}
