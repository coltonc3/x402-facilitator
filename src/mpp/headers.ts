import type { MppChallengeParams } from "./types.js";

/**
 * Formats the WWW-Authenticate: Payment header returned in a 402 challenge.
 * https://mpp.dev — RFC 7235 auth-scheme format.
 */
export function buildWwwAuthenticate(params: MppChallengeParams & { id: string }): string {
  const parts: string[] = [
    `Payment id="${params.id}"`,
    `method="${params.method}"`,
    `intent="${params.intent}"`,
    `amount="${params.amount}"`,
    `currency="${params.currency}"`,
  ];
  parts.push(`recipient="${params.payTo}"`);
  if (params.description) parts.push(`description="${params.description}"`);
  if (params.realm)       parts.push(`realm="${params.realm}"`);
  return parts.join(", ");
}

export interface MppCredential {
  id:      string;
  method:  string;
  payload: Record<string, unknown>;
}

/**
 * Parses an Authorization: Payment header from an MPP client.
 * Returns null if the header is not a valid MPP credential.
 *
 * Header format:
 *   Authorization: Payment id="...", method="...", payload="{...}"
 *
 * Values are quoted strings; internal quotes are backslash-escaped.
 */
export function parseMppCredential(header: string): MppCredential | null {
  if (!header.startsWith("Payment ")) return null;

  const fields: Record<string, string> = {};
  const re = /(\w+)="((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    fields[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }

  if (!fields["id"] || !fields["method"] || !fields["payload"]) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(fields["payload"]) as Record<string, unknown>;
  } catch {
    return null;
  }

  return { id: fields["id"], method: fields["method"], payload };
}

/**
 * Formats the Payment-Receipt header returned in a successful 200 response.
 */
export function buildPaymentReceipt(id: string, method: string): string {
  return `id="${id}", method="${method}", settled="true"`;
}
