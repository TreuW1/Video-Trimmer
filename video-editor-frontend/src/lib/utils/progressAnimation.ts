export function animateProgressValue(options: {
  from: number;
  to: number;
  durationMs?: number;
  setValue: (value: number) => void;
}): () => void {
  const durationMs = options.durationMs ?? 500;
  const startTime = Date.now();
  let animationFrameId = 0;
  let cancelled = false;

  function updateProgress() {
    if (cancelled) return;

    const elapsed = Date.now() - startTime;
    const progress = Math.min(elapsed / durationMs, 1);
    const easedProgress = 1 - Math.pow(1 - progress, 2);

    options.setValue(options.from + (options.to - options.from) * easedProgress);

    if (progress < 1) {
      animationFrameId = requestAnimationFrame(updateProgress);
    }
  }

  animationFrameId = requestAnimationFrame(updateProgress);

  return () => {
    cancelled = true;
    cancelAnimationFrame(animationFrameId);
  };
}
