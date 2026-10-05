import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import * as api from "./lib/api";
import { setConnected, useApp } from "./store/app";
import { startTransferSync } from "./store/transfers";
import { ConnectScreen } from "./components/ConnectScreen";
import { Explorer } from "./components/Explorer";
import { Toasts } from "./components/Toasts";
import { SettingsDialog } from "./components/SettingsDialog";
import { loadSettings } from "./store/settings";

export default function App() {
  const connected = useApp((s) => s.connection !== null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    let stop: (() => void) | null = null;
    let disposed = false;
    // Settings work while disconnected, so load them independently of the connection.
    void loadSettings();
    startTransferSync()
      .then((s) => (disposed ? s() : (stop = s)))
      .catch(() => {});
    api
      .connectionStatus()
      .then((info) => {
        if (info && !disposed) setConnected(info);
      })
      .catch(() => {})
      .finally(() => !disposed && setBooting(false));
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  // Suppress the default webview context menu everywhere except text inputs.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA") e.preventDefault();
    };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  return (
    <>
      {booting ? (
        <div className="boot">
          <Loader2 size={20} className="spin" />
        </div>
      ) : connected ? (
        <Explorer />
      ) : (
        <ConnectScreen />
      )}
      <SettingsDialog />
      <Toasts />
    </>
  );
}
