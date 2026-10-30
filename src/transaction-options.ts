// Allow for network round trips to hosted PostgreSQL while keeping writes bounded.
export const transactionOptions = { maxWait: 10000, timeout: 20000 };
