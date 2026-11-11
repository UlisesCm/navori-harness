/** Fictitious identifier used by the privacy tests; never a real person. */
export const FAKE_ID = "ana.ficticia+qa@example.test";

/**
 * Every spelling of `id` a payload leak could take, as raw bytes: clear, upper case, URL-encoded
 * (`%40`, `%2B`), `\u0040` escapes, hex, and base64 / base64url at the three byte alignments
 * (edge characters that depend on neighbouring bytes are trimmed). The local part and the domain
 * are searched on their own as well.
 */
export function leakVariants(id: string = FAKE_ID): Buffer[] {
  const encoded = id.replace("@", "%40");
  const plain = [
    id,
    id.toUpperCase(),
    encoded,
    id.replace("+", "%2B"),
    encoded.replace("+", "%2B"),
    encoded.replace("+", "%2b"),
    id.replace("@", "\\u0040"),
    id.replace("+", "\\u002b"),
    ...id.split("@"),
    Buffer.from(id).toString("hex"),
    Buffer.from(id).toString("hex").toUpperCase(),
  ].map((text: string): Buffer => Buffer.from(text));
  const encoded64: Buffer[] = [];
  for (const encoding of ["base64", "base64url"] as const) {
    for (let filler = 0; filler < 3; filler++) {
      const text = Buffer.concat([Buffer.alloc(filler, 0x78), Buffer.from(id)]).toString(encoding);
      encoded64.push(Buffer.from(text.slice(4, text.length - 4)));
    }
  }
  return [...plain, ...encoded64];
}

/** How many variants occur in `haystack`; a count, so no assertion message can echo the id. */
export function leakCount(haystack: Uint8Array, id: string = FAKE_ID): number {
  const buffer = Buffer.from(haystack);
  return leakVariants(id).filter((needle: Buffer): boolean => buffer.includes(needle)).length;
}

/** A realistic hook payload holding the fictitious identifier. */
export function leakPayload(id: string = FAKE_ID): string {
  const command = `curl -s 'https://api.example.test/?u=${id}'`;
  return JSON.stringify({ tool_input: { command }, cwd: "/tmp/ficticio" });
}

/**
 * The whole payload as a leak could write it: clear, base64, base64url, hex (both cases) and
 * URL-encoded. Positive control: `leakCount` must be > 0 for every one of them.
 */
export function payloadEncodings(payload: string = leakPayload()): Buffer[] {
  const raw = Buffer.from(payload);
  return [
    raw,
    Buffer.from(raw.toString("base64")),
    Buffer.from(raw.toString("base64url")),
    Buffer.from(raw.toString("hex")),
    Buffer.from(raw.toString("hex").toUpperCase()),
    Buffer.from(payload.replaceAll("@", "%40").replaceAll("+", "%2B")),
  ];
}
