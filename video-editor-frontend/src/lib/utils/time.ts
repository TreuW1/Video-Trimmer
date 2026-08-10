export function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const milliseconds = Math.floor((seconds % 1) * 1000);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
}

export function parseTime(timeString: string): number {
  const parts = timeString.split(':');
  const hours = parseInt(parts[0]) || 0;
  const minutes = parseInt(parts[1]) || 0;
  const secondsParts = parts[2] ? parts[2].split('.') : ['0', '0'];
  const seconds = parseInt(secondsParts[0]) || 0;
  const frac = secondsParts[1] || '0';
  let milliseconds = 0;
  if (frac.length >= 3) {
    milliseconds = parseInt(frac.slice(0, 3)) || 0;
  } else if (frac.length === 2) {
    milliseconds = (parseInt(frac) || 0) * 10;
  } else if (frac.length === 1) {
    milliseconds = (parseInt(frac) || 0) * 100;
  }
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

export function formatElapsedTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

