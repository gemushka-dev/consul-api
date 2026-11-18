export interface ConsulReplyCardRow {
  label: string;
  value: string | number;
}

export interface ConsulReplyCard {
  title: string;
  value?: string | number;
  subtitle?: string;
  rows?: ConsulReplyCardRow[];
}

export interface VerifiableReply {
  text: string;
  card?: ConsulReplyCard | null;
}

export interface VerifyNumbersResult {
  ok: boolean;
  extracted: number[];
  ungrounded: number[];
}

/**
 * Extracts all numeric values from human-facing text, including:
 * - spaced thousands: "4 200 000", "1 797 617"
 * - scaled phrases: "4,2 mln", "34 млн", "500 ming", "1.5 млрд"
 * - plain decimals / integers / percentages: "24%", "16.0"
 */
export function extractNumbersFromText(text: string): number[] {
  if (!text) return [];
  const normalized = text.replace(/\u00a0/g, ' ');
  const found: number[] = [];

  // Strip ISO dates like 2026-11-18 and masked IDs like D1, D2 before scanning
  const cleaned = normalized
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\bD\d+\b/g, ' ');

  // 1. Capture scaled numbers first (e.g. "4,2 mln", "34 млн", "500 ming")
  const scaledRegex =
    /(-?\d+(?:[.,]\d+)?)\s*(mlrd|млрд|mln|млн|ming|тыс\.?)(?![a-zа-яё])/gi;
  let withoutScaled = cleaned;
  let m: RegExpExecArray | null;
  while ((m = scaledRegex.exec(cleaned)) !== null) {
    const rawNum = Number(m[1]!.replace(',', '.'));
    const unit = m[2]!.toLowerCase();
    if (Number.isFinite(rawNum)) {
      const mult =
        unit.startsWith('mlrd') || unit.startsWith('млрд')
          ? 1_000_000_000
          : unit.startsWith('mln') || unit.startsWith('млн')
            ? 1_000_000
            : 1_000;
      found.push(Math.round(rawNum * mult));
    }
  }
  withoutScaled = cleaned.replace(scaledRegex, ' ');

  // 2. Capture spaced integers (e.g. "1 797 617", "12 000 000")
  const spacedRegex = /-?\d{1,3}(?: \d{3})+/g;
  let withoutSpaced = withoutScaled;
  while ((m = spacedRegex.exec(withoutScaled)) !== null) {
    const val = Number(m[0].replace(/ /g, ''));
    if (Number.isFinite(val)) found.push(val);
  }
  withoutSpaced = withoutScaled.replace(spacedRegex, ' ');

  // 3. Capture remaining plain integers / decimals
  const plainRegex = /-?\d+(?:[.,]\d+)?/g;
  while ((m = plainRegex.exec(withoutSpaced)) !== null) {
    const val = Number(m[0].replace(',', '.'));
    if (Number.isFinite(val)) found.push(val);
  }

  return found;
}

/** Recursively collects all numeric values from tool output payloads. */
export function collectNumbersFromData(data: unknown, out: Set<number> = new Set()): Set<number> {
  if (typeof data === 'number' && Number.isFinite(data)) {
    out.add(data);
    out.add(Math.abs(data));
    out.add(Math.round(data));
    out.add(Math.round(Math.abs(data)));
    return out;
  }
  if (typeof data === 'string') {
    for (const n of extractNumbersFromText(data)) {
      out.add(n);
      out.add(Math.abs(n));
    }
    return out;
  }
  if (Array.isArray(data)) {
    for (const item of data) collectNumbersFromData(item, out);
    return out;
  }
  if (data && typeof data === 'object') {
    for (const v of Object.values(data as Record<string, unknown>)) {
      collectNumbersFromData(v, out);
    }
  }
  return out;
}

// Non-financial small structural numbers (list indices, days/months constants, DTI 35%)
const STRUCTURAL_ALLOWLIST = new Set<number>([0, 1, 2, 3, 4, 5, 6, 7, 10, 12, 24, 30, 35, 100, 2026]);

function isGroundedNumber(candidate: number, groundedSet: Set<number>): boolean {
  const abs = Math.abs(candidate);
  if (STRUCTURAL_ALLOWLIST.has(abs)) return true;

  for (const g of groundedSet) {
    const gAbs = Math.abs(g);
    // Exact or tiny rounding tolerance (<= 1% for human-rounded mln figures like 4.2 mln vs 4,200,000)
    if (Math.abs(abs - gAbs) <= 1) return true;
    if (gAbs >= 1000 && Math.abs(abs - gAbs) / gAbs <= 0.015) return true;
    // Allow rounded display in millions or thousands (e.g. 4.2 for 4,200,000)
    if (gAbs >= 1_000_000 && Math.abs(abs - gAbs / 1_000_000) <= 0.06) return true;
    if (gAbs >= 1_000 && Math.abs(abs - gAbs / 1_000) <= 1) return true;
  }

  return false;
}

/**
 * Grounding Check: parses all numbers from reply.text, reply.card.value, and reply.card.rows,
 * and cross-checks them against numbers returned by tool calls + user prompt.
 * Rejects any hallucinated financial figure.
 */
export function verifyNumbers(
  reply: VerifiableReply,
  toolOutputs: unknown[],
  userPromptText = '',
): VerifyNumbersResult {
  const grounded = new Set<number>();
  for (const output of toolOutputs) {
    collectNumbersFromData(output, grounded);
  }
  for (const n of extractNumbersFromText(userPromptText)) {
    grounded.add(n);
    grounded.add(Math.abs(n));
  }

  const candidateTexts: string[] = [reply.text];
  if (reply.card?.value !== undefined) {
    candidateTexts.push(String(reply.card.value));
  }
  if (reply.card?.rows) {
    for (const row of reply.card.rows) {
      candidateTexts.push(String(row.value));
    }
  }

  const extracted: number[] = [];
  for (const t of candidateTexts) {
    extracted.push(...extractNumbersFromText(t));
  }

  const ungrounded = extracted.filter((n) => !isGroundedNumber(n, grounded));

  return {
    ok: ungrounded.length === 0,
    extracted,
    ungrounded,
  };
}
