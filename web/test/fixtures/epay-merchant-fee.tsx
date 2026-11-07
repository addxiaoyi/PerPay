import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../../src/api/client";
import EPayMerchants from "../../src/pages/EPayMerchants";
import "../../src/styles.css";

createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><main className="mx-auto max-w-5xl p-4"><EPayMerchants /></main></QueryClientProvider>);
