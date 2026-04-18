let debugEnabled = false;

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

function prefix(level: string): string {
  return `[langsmith-opencode:${level}]`;
}

export function debug(message: unknown, ...args: unknown[]): void {
  if (!debugEnabled) return;
  // eslint-disable-next-line no-console
  console.error(prefix("debug"), message, ...args);
}

export function log(message: unknown, ...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error(prefix("info"), message, ...args);
}

export function warn(message: unknown, ...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error(prefix("warn"), message, ...args);
}

export function error(message: unknown, ...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error(prefix("error"), message, ...args);
}
