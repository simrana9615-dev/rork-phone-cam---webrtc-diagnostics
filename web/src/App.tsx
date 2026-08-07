import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { PhoneGate } from "@/components/PhoneGate";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import ArchiveViewer from "./pages/ArchiveViewer";
import Calibrate from "./pages/Calibrate";
import Dashboard from "./pages/Dashboard";
import DeepProbe from "./pages/DeepProbe";
import DeviceSpec from "./pages/DeviceSpec";
import IdKitFlow from "./pages/IdKitFlow";
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";
import SharedReport from "./pages/SharedReport";
import Verify from "./pages/Verify";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <PhoneGate>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <ErrorBoundary>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/idkit" element={<IdKitFlow variant="licence" />} />
              <Route path="/eyedeekit/licence" element={<IdKitFlow variant="licence" />} />
              <Route path="/eyedeekit/passport" element={<IdKitFlow variant="passport" />} />
              <Route path="/verify/:templateId" element={<Verify />} />
              <Route path="/advanced" element={<Index />} />
              <Route path="/device-spec" element={<DeviceSpec />} />
              <Route path="/deep-probe" element={<DeepProbe />} />
              <Route path="/archive" element={<ArchiveViewer />} />
              <Route path="/calibrate" element={<Calibrate />} />
              <Route path="/shared" element={<SharedReport />} />
              {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </ErrorBoundary>
        </BrowserRouter>
      </PhoneGate>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
