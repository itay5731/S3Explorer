import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import * as api from "./lib/api";
import { setConnected, useApp } from "./store/app";
import { startTransferSync } from "./store/transfers";
import { startJobSync } from "./store/jobs";
import { startBatchSync } from "./store/batches";
import { installHistory } from "./store/history";
import { ConnectScreen } from "./components/ConnectScreen";
import { Explorer } from "./components/Explorer";
import { Toasts } from "./components/Toasts";
import { SettingsDialog } from "./components/SettingsDialog";
import { UpdateDialog } from "./components/UpdateDialog";
import { loadSettings, useSettings } from "./store/settings";
import { checkWhatsNew, scheduleStartupCheck } from "./store/updates";
import { startLaunch } from "./store/launch";

export default function App() {
  const connected = useApp((s) => s.connection !== null);
  const connectionName = useApp((s) => s.connection?.label);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    let stop: (() => void) | null = null;
    let stopJobs: (() => void) | null = null;
    let stopBatches: (() => void) | null = null;
    let cancelUpdateCheck: (() => void) | null = null;
    let disposed = false;
    // Before the syncs start, so no finish event is missed; also while disconnected.
    const stopHistory = installHistory();
    // Settings work while disconnected, so load them independently of the connection.
    let stopLaunch: (() => void) | null = null;
    const settingsLoaded = loadSettings();
    void settingsLoaded.then(() => {
      if (disposed) return;
      // The first launch after an update shows what changed.
      void checkWhatsNew();
      // Optional silent update check a few seconds after launch; never installs anything.
      if (useSettings.getState().settings?.checkUpdatesOnStartup) cancelUpdateCheck = scheduleStartupCheck();
    });
    startTransferSync()
      .then((s) => (disposed ? s() : (stop = s)))
      .catch(() => {});
    startJobSync()
      .then((s) => (disposed ? s() : (stopJobs = s)))
      .catch(() => {});
    startBatchSync()
      .then((s) => (disposed ? s() : (stopBatches = s)))
      .catch(() => {});
    api
      .connectionStatus()
      .then((info) => {
        if (info && !disposed) setConnected(info);
      })
      .catch(() => {})
      .finally(() => {
        if (disposed) return;
        setBooting(false);
        // v0.9.0: the command line's location, once settings and the connection status are known.
        void settingsLoaded.then(() => startLaunch()).then((off) => (disposed ? off() : (stopLaunch = off)));
      });
    return () => {
      disposed = true;
      stop?.();
      stopJobs?.();
      stopBatches?.();
      cancelUpdateCheck?.();
      stopLaunch?.();
      stopHistory();
    };
  }, []);

  // The window title names the open connection, so several windows can be told apart in the taskbar.
  useEffect(() => {
    api.setWindowTitle(connectionName ?? "S3 Explorer").catch(() => {});
  }, [connectionName]);

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
      <UpdateDialog />
      <Toasts />
    </>
  );
}
