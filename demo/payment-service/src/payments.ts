import { FakeDbPool } from "./fake-db.js";

export type UserTier = "free" | "premium" | "enterprise";

export interface PaymentUser {
  id: string;
  tier: UserTier;
}

export interface PaymentInput {
  user: PaymentUser;
  amountCents: number;
}

export interface PaymentReceipt {
  paymentId: string;
  userId: string;
  amountCents: number;
  remainingBalanceCents: number;
}

export class InsufficientFundsError extends Error {
  public readonly code = "InsufficientFunds";

  public constructor(
    public readonly amountCents: number,
    public readonly availableBalanceCents: number,
  ) {
    super("The account does not have enough funds for this payment");
    this.name = "InsufficientFundsError";
  }
}

export class PaymentDatabaseError extends Error {
  public readonly code = "PaymentDatabaseUnavailable";

  public constructor() {
    super("The payment database could not complete the transaction");
    this.name = "PaymentDatabaseError";
  }
}

export class PaymentProcessor {
  #nextPaymentId = 1;

  public constructor(
    public readonly pool: FakeDbPool,
    public readonly bugEnabled: boolean,
  ) {}

  public async pay(input: PaymentInput): Promise<PaymentReceipt> {
    const user = input.user;
    const amountCents = input.amountCents;
    const pool = this.pool;
    const releaseExhaustion =
      this.bugEnabled && user.tier === "free" ? pool.exhaust() : () => {};
    let balance: number | null = null;

    try {
      balance = await pool.getBalance(user.id);
      const availableBalanceCents = balance ?? 0; // LIVEPROBE_SNAPSHOT_TARGET

      if (availableBalanceCents < amountCents) {
        throw new InsufficientFundsError(amountCents, availableBalanceCents);
      }

      const debited = await pool.debit(user.id, amountCents);
      if (!debited) {
        throw new PaymentDatabaseError();
      }

      const paymentId = `pmt_${String(this.#nextPaymentId).padStart(6, "0")}`;
      this.#nextPaymentId += 1;
      return {
        paymentId,
        userId: user.id,
        amountCents,
        remainingBalanceCents: availableBalanceCents - amountCents,
      };
    } finally {
      releaseExhaustion();
    }
  }
}
