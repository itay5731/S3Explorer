import { useEffect, useId } from "react";
import { AlertCircle, ArrowUpCircle, CheckCircle2, Download, ExternalLink, Info, Loader2, RefreshCw } from "lucide-react";
import * as api from "../lib/api";
import { formatBytes, formatExact, formatRelative } from "../lib/format";
import { checkForUpdates, dismissUpdateNotice, installUpdate, loadVersion, useUpdates, type InstallState } from "../store/updates";
import { selectActiveCount, useTransfers } from "../store/transfers";
import { toast } from "../store/toasts";
import type { AppError, UpdateInfo } from "../lib/types";
import { Markdown } from "./Markdown";

const PHASE_LABEL: Record<InstallState["phase"], string> = {
  starting: "Preparing…",
  downloading: "Downloading update…",
  installing: "Installing…",
  restarting: "Restarting…",
};

function InstallProgress({ install }: { install: InstallState }) {
  const known = install.phase === "downloading" && !!install.totalBytes;
  const pct = known ? Math.min(100, (install.downloadedBytes / install.totalBytes!) * 100) : 0;
  return (
    <div className="upd-progress" role="status" aria-live="polite">
      <div className="upd-progress-head">
        <Loader2 size={14} className="spin" />
        <span>{PHASE_LABEL[install.phase]}</span>
        <span className="spacer" />
        {install.phase === "downloading" && (
          <span className="muted small tabular">
            {formatBytes(install.downloadedBytes)}
            {install.totalBytes ? ` / ${formatBytes(install.totalBytes)}` : ""}
          </span>
        )}
      </div>
      <div
        className={`pbar ${known ? "" : "indeterminate"}`}
        role="progressbar"
        aria-label="Update progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? Math.round(pct) : undefined}
      >
        {known && <div className="pbar-fill" style={{ transform: `scaleX(${pct / 100})` }} />}
      </div>
      <p className="muted small">The app restarts by itself when the update is installed.</p>
    </div>
  );
}

function Available({ info }: { info: UpdateInfo }) {
  const install = useUpdates((s) => s.install);
  const installError = useUpdates((s) => s.installError);
  const activeTransfers = useTransfers(selectActiveCount);

  const openDownloadPage = () =>
    api.openExternal(info.downloadUrl).catch((e: AppError) => toast.error("Couldn't open the download page", e));

  return (
    <div className="upd-card available">
      <div className="upd-card-head">
        <ArrowUpCircle size={18} className="upd-icon accent" />
        <div className="upd-card-title">
          <strong>Version {info.latestVersion ?? "?"} is available</strong>
          {info.publishedAt && (
            <span className="muted small" title={formatExact(info.publishedAt)}>
              Released {formatRelative(info.publishedAt)}
            </span>
          )}
        </div>
      </div>
      {info.notes?.trim() ? (
        <div className="upd-notes" tabIndex={0} aria-label="Release notes">
          <Markdown source={info.notes} />
        </div>
      ) : (
        <p className="muted small">No release notes were published for this version.</p>
      )}
      {install ? (
        <InstallProgress install={install} />
      ) : info.canInstall ? (
        <>
          {activeTransfers > 0 && (
            <div className="callout warn" role="note">
              <AlertCircle size={15} />
              <span>
                {activeTransfers} {activeTransfers === 1 ? "transfer is" : "transfers are"} still running. Installing
                restarts the app, so wait for them to finish or cancel them first.
              </span>
            </div>
          )}
          {installError && (
            <div className="form-error" role="alert">
              <AlertCircle size={15} />
              <span>
                <strong>Couldn't install the update.</strong> {installError.message}
              </span>
            </div>
          )}
          <div className="upd-actions">
            <button type="button" className="btn btn-primary" onClick={() => void installUpdate()}>
              <Download size={14} /> Install and restart
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="upd-actions">
            <button type="button" className="btn btn-primary" onClick={() => void openDownloadPage()}>
              <ExternalLink size={14} /> Open download page
            </button>
          </div>
          <p className="muted small">Automatic install isn't available for this build. Download and install it manually.</p>
        </>
      )}
    </div>
  );
}

export function UpdatesTab({
  checkOnStartup,
  disabled,
  onCheckOnStartupChange,
}: {
  checkOnStartup: boolean;
  disabled: boolean;
  onCheckOnStartupChange(v: boolean): void;
}) {
  const id = useId();
  const version = useUpdates((s) => s.version);
  const status = useUpdates((s) => s.status);
  const info = useUpdates((s) => s.info);
  const error = useUpdates((s) => s.error);
  const checkedAt = useUpdates((s) => s.checkedAt);
  const installing = useUpdates((s) => s.install !== null);

  useEffect(() => {
    void loadVersion();
    dismissUpdateNotice();
  }, []);

  const checking = status === "checking";

  return (
    <div className="set-panel-body">
      <div className="upd-version">
        <div>
          <div className="set-label">S3 Explorer {version ? `v${version}` : ""}</div>
          <p className="set-desc">
            {checkedAt ? `Last checked ${formatRelative(new Date(checkedAt).toISOString())}.` : "Updates come from the project's GitHub releases."}
          </p>
        </div>
        <button type="button" className="btn" onClick={() => void checkForUpdates()} disabled={checking || installing}>
          {checking ? <Loader2 size={14} className="spin" /> : <RefreshCw size={13} />}
          {checking ? "Checking…" : "Check for updates"}
        </button>
      </div>

      <div aria-live="polite">
        {checking ? (
          <div className="upd-card muted">
            <Loader2 size={16} className="spin" /> Checking for updates…
          </div>
        ) : status === "error" && error ? (
          <div className="upd-card">
            <div className="form-error" role="alert">
              <AlertCircle size={15} />
              <span>
                <strong>Couldn't check for updates.</strong> {error.message}
              </span>
            </div>
            <div className="upd-actions">
              <button type="button" className="btn" onClick={() => void checkForUpdates()}>
                <RefreshCw size={13} /> Try again
              </button>
            </div>
          </div>
        ) : info && info.available ? (
          <Available info={info} />
        ) : info ? (
          <div className="upd-card ok">
            <CheckCircle2 size={18} className="upd-icon success" />
            <span>You're on the latest version, v{info.currentVersion}.</span>
          </div>
        ) : null}
      </div>

      <div className="set-field">
        <label className="toggle-row" htmlFor={`${id}-startup`}>
          <span className="set-field-head">
            <span className="set-label">Check for updates when the app starts</span>
            <span className="set-desc">
              A quick, silent check a few seconds after launch. You'll see a notice if an update is available; nothing is
              installed without you.
            </span>
          </span>
          <input
            id={`${id}-startup`}
            type="checkbox"
            role="switch"
            className="switch"
            checked={checkOnStartup}
            disabled={disabled}
            onChange={(e) => onCheckOnStartupChange(e.target.checked)}
          />
        </label>
      </div>

      <div className="callout info" role="note">
        <Info size={15} />
        <span>Updates are verified with the project's signing key before they are installed.</span>
      </div>
    </div>
  );
}
