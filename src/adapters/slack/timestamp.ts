/** Slack timestamps are decimal identifiers; never round-trip them through floats. */
export function parseSlackTimestamp(value: unknown):
  | {
      ts: string;
      date: Date;
      sequence: number;
    }
  | undefined {
  if (typeof value !== "string" || !/^\d{1,12}\.\d{6}$/.test(value))
    return undefined;
  const [seconds, micros] = value.split(".");
  if (!seconds || !micros) return undefined;
  // Reject alternate spellings of the same identifier.
  if (seconds.length > 1 && seconds.startsWith("0")) return undefined;
  const date = new Date(Number(seconds) * 1000 + Number(micros.slice(0, 3)));
  if (Number.isNaN(date.getTime()) || !/^\d{4}-/.test(date.toISOString()))
    return undefined;
  return { ts: value, date, sequence: Number(micros) };
}

export function compareSlackTimestamps(left: string, right: string): number {
  const a = BigInt(left.replace(".", ""));
  const b = BigInt(right.replace(".", ""));
  return a < b ? -1 : a > b ? 1 : 0;
}
