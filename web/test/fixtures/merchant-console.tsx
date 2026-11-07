import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../../src/api/client";
import MerchantConsole from "../../src/pages/MerchantConsole";
import "../../src/styles.css";

createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><MerchantConsole /></QueryClientProvider>);
