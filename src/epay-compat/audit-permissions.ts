const USAGE = "GRANT USAGE ON *.* TO `epay_audit`@`localhost`";
const SELECT = "GRANT SELECT ON `epay_starmc`.* TO `epay_audit`@`localhost`";

export function verifyAuditPermissions(account: unknown, activeRole: unknown, grants: readonly unknown[]): void {
  if (account !== "epay_audit@localhost" || activeRole !== "NONE" || grants.length !== 2 || new Set(grants).size !== 2 || !grants.includes(USAGE) || !grants.includes(SELECT)) {
    throw new Error("isolated audit account has unexpected privileges or roles");
  }
}
