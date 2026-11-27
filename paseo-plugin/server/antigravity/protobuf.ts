/** Minimal protobuf reader for agy's conversation records. Only what the plugin needs. */

export type Fields = Map<number, Array<number | Uint8Array>>;

function readVarint(buffer: Uint8Array, start: number): [number, number] | null {
  let result = 0;
  let multiplier = 1;
  let position = start;
  for (let shift = 0; shift < 64; shift += 7) {
    if (position >= buffer.length) return null;
    const byte = buffer[position++]!;
    result += (byte & 0x7f) * multiplier;
    multiplier *= 128;
    if ((byte & 0x80) === 0) return [result, position];
  }
  return null;
}

/** Decodes one message level; returns null when the bytes are not a message. */
export function decode(buffer: Uint8Array | null | undefined): Fields | null {
  if (!buffer) return null;
  const fields: Fields = new Map();
  let position = 0;
  while (position < buffer.length) {
    const key = readVarint(buffer, position);
    if (!key) return null;
    position = key[1];
    const field = Math.floor(key[0] / 8);
    const wireType = key[0] % 8;
    if (field === 0) return null;
    let value: number | Uint8Array;
    if (wireType === 0) {
      const varint = readVarint(buffer, position);
      if (!varint) return null;
      [value, position] = varint;
    } else if (wireType === 1) {
      position += 8;
      continue;
    } else if (wireType === 5) {
      position += 4;
      continue;
    } else if (wireType === 2) {
      const length = readVarint(buffer, position);
      if (!length) return null;
      position = length[1];
      if (position + length[0] > buffer.length) return null;
      value = buffer.subarray(position, position + length[0]);
      position += length[0];
    } else {
      return null;
    }
    const list = fields.get(field);
    if (list) list.push(value);
    else fields.set(field, [value]);
  }
  return fields;
}

export function message(fields: Fields | null, path: readonly number[]): Fields | null {
  let current = fields;
  for (const field of path) {
    const value = current?.get(field)?.find((entry): entry is Uint8Array => entry instanceof Uint8Array);
    if (!value) return null;
    current = decode(value);
  }
  return current;
}

export function int(fields: Fields | null, field: number): number {
  const value = fields?.get(field)?.find((entry): entry is number => typeof entry === "number");
  return value ?? 0;
}

const utf8 = new TextDecoder("utf-8", { fatal: false });

export function text(fields: Fields | null, field: number): string | null {
  const value = fields?.get(field)?.find((entry): entry is Uint8Array => entry instanceof Uint8Array);
  return value ? utf8.decode(value) : null;
}

/** google.protobuf.Duration or Timestamp as seconds: { 1: seconds, 2: nanos }. */
export function seconds(fields: Fields | null): number {
  if (!fields) return 0;
  return int(fields, 1) + int(fields, 2) / 1e9;
}
