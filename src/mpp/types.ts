export interface MppChallengeParams {
  method: string;
  intent: "charge" | "session";
  amount: string;
  currency: string;
  payTo: string;
  description?: string;
  realm?: string;
}

export interface MppVerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}
