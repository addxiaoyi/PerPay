import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/app/globals.css";
import { ShadowCallbacks } from "../../src/components/shadow-callbacks";

const root = document.getElementById("root");
if (!root) throw new Error("fixture root missing");
function Fixture() {
  const [merchantId, setMerchantId] = useState("fixture-merchant");
  return <main className="mx-auto w-full max-w-4xl p-4"><button type="button" onClick={() => setMerchantId((current) => current === "fixture-merchant" ? "other-merchant" : "fixture-merchant")}>Switch merchant</button><ShadowCallbacks merchantId={merchantId} orders={[
  { id: "epay_order-a", source: "epay" },
  { id: "epay_order-b", source: "epay" },
  { id: "epay_order-error", source: "epay" },
  { id: `epay_${"x".repeat(64)}`, source: "epay" },
]} /></main>;
}

createRoot(root).render(<Fixture />);
