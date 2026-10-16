import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { X3Provider, useX3 } from "@x3growth/sdk/react";

function PricingButton() {
  const x3 = useX3();
  return <button onClick={() => x3.track("plan_selected", { plan: "pro" })}>Choose Pro</button>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* one tracker per app; route changes are detected via the History API */}
    <X3Provider options={{ key: import.meta.env.VITE_X3_KEY, host: "https://api.x3growth.io" }}>
      <PricingButton />
    </X3Provider>
  </StrictMode>,
);
