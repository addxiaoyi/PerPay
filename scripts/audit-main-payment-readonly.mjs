import { readFileSync } from "node:fs";
import { auditMainPayments } from "../dist/epay-compat/main-payment-audit.js";

const path = process.argv[2];
if (!path) throw new Error("expected a read-only main-site store path");
let root;
try { root = JSON.parse(readFileSync(path, "utf8")); }
catch { throw new Error("unable to read or parse main-site store"); }
const report = auditMainPayments(root.payment);
console.log(JSON.stringify({ source: "main_store_file_readonly", coordinatedSnapshot: false, ...report }));
