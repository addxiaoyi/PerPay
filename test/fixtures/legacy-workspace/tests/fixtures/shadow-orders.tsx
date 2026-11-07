import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ShadowOrders } from "../../src/components/shadow-orders";

const root = document.getElementById("root");
if (!root) throw new Error("fixture root missing");
function Fixture() {
  const [merchantId, setMerchantId] = useState("fixture-merchant");
  return <><button type="button" onClick={() => setMerchantId((current) => current === "fixture-merchant" ? "other-merchant" : "fixture-merchant")}>Switch merchant</button><ShadowOrders merchantId={merchantId} /></>;
}
createRoot(root).render(<Fixture />);
