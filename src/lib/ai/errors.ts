/** The workspace has no AI key and the instance has no default key. */
export class MissingKeyError extends Error {
  constructor() {
    super("No AI key configured for this workspace");
    this.name = "MissingKeyError";
  }
}

/** The provider rejected the key (revoked, mistyped, wrong project). */
export class InvalidKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidKeyError";
  }
}

/** The key is valid but out of quota or rate limited. */
export class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaError";
  }
}
