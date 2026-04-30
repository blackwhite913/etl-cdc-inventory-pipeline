type LogLevel = "info" | "warn" | "error";
type LogPayload = Record<string, unknown>;

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function log(tag: string, level: LogLevel, payload: LogPayload = {}): void {
  const entries = Object.entries(payload).map(([key, value]) => `${key}=${formatValue(value)}`);
  const line = [`[${tag}]`, ...entries].join(" ");

  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.info(line);
}
