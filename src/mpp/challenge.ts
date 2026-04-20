/**
 * Self-contained MPP challenge IDs.
 *
 * Format: base64url(claims).HMAC-SHA256(claims, secretKey)
 *
 * Claims contain method, amount, currency, payTo, issuedAt, and a random jti.
 * The server verifies HMAC + TTL + field binding; the jti is used for replay protection.
 * No server-side state is required to issue or verify challenges.
 */

import { createHmac, randomUUID } from "crypto";

const TTL_SECONDS = 300;

interface Claims {
  method:   string;
  amount:   string;
  currency: string;
  payTo:    string;
  iat:      number;
  jti:      string;
}

export function createChallengeId(
  method:    string,
  amount:    string,
  currency:  string,
  payTo:     string,
  secretKey: string,
): string {
  const claims: Claims = {
    method,
    amount,
    currency: currency.toLowerCase(),
    payTo:    payTo.toLowerCase(),
    iat:      Math.floor(Date.now() / 1000),
    jti:      randomUUID(),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createHmac("sha256", secretKey).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export type ChallengeVerifyResult =
  | { valid: true;  jti: string }
  | { valid: false; reason: string };

export function verifyChallengeId(
  id:       string,
  expected: { method: string; amount: string; currency: string; payTo: string },
  secretKey: string,
): ChallengeVerifyResult {
  const dot = id.lastIndexOf(".");
  if (dot === -1) return { valid: false, reason: "malformed challenge id" };

  const payload = id.slice(0, dot);
  const sig     = id.slice(dot + 1);

  const expectedSig = createHmac("sha256", secretKey).update(payload).digest("base64url");
  if (sig !== expectedSig) return { valid: false, reason: "invalid challenge signature" };

  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Claims;
  } catch {
    return { valid: false, reason: "malformed challenge payload" };
  }

  const age = Math.floor(Date.now() / 1000) - claims.iat;
  if (age > TTL_SECONDS) return { valid: false, reason: "challenge expired" };
  if (age < 0)           return { valid: false, reason: "challenge issued in the future" };

  if (claims.method   !== expected.method)                 return { valid: false, reason: "method mismatch" };
  if (claims.amount   !== expected.amount)                 return { valid: false, reason: "amount mismatch" };
  if (claims.currency !== expected.currency.toLowerCase()) return { valid: false, reason: "currency mismatch" };
  if (claims.payTo    !== expected.payTo.toLowerCase())    return { valid: false, reason: "payTo mismatch" };

  return { valid: true, jti: claims.jti };
}
