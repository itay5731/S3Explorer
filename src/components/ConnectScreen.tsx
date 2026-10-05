import { useEffect, useState, type FormEvent } from "react";
import { ChevronRight, Eye, EyeOff, KeyRound, Loader2, RefreshCw, UserRound, Server, AlertCircle } from "lucide-react";
import * as api from "../lib/api";
import type { AppError, ConnectionConfig, ProfileInfo } from "../lib/types";
import { setConnected, writePref } from "../store/app";
import { Logo } from "./Logo";
import { SettingsButton } from "./SettingsDialog";

type Mode = "profile" | "static";

/** What we remember between launches. Never contains secrets. */
interface SavedConnection {
  mode: Mode;
  profile: string;
  profileRegion: string;
  profileEndpoint: string;
  accessKeyId: string;
  region: string;
  endpoint: string;
  forcePathStyle: boolean;
}

const PREF_KEY = "s3x.lastConnection";

function loadSaved(): SavedConnection {
  const defaults: SavedConnection = {
    mode: "profile",
    profile: "",
    profileRegion: "",
    profileEndpoint: "",
    accessKeyId: "",
    region: "us-east-1",
    endpoint: "",
    forcePathStyle: true,
  };
  try {
    const raw = localStorage.getItem(PREF_KEY);
    return raw ? { ...defaults, ...(JSON.parse(raw) as Partial<SavedConnection>) } : defaults;
  } catch {
    return defaults;
  }
}

export function ConnectScreen() {
  const [saved] = useState(loadSaved);
  const [mode, setMode] = useState<Mode>(saved.mode);
  const [profiles, setProfiles] = useState<ProfileInfo[] | null>(null);
  const [profilesError, setProfilesError] = useState<AppError | null>(null);
  const [profile, setProfile] = useState(saved.profile);
  const [profileRegion, setProfileRegion] = useState(saved.profileRegion);
  const [profileEndpoint, setProfileEndpoint] = useState(saved.profileEndpoint);
  const [showAdvanced, setShowAdvanced] = useState(!!(saved.profileRegion || saved.profileEndpoint));

  const [accessKeyId, setAccessKeyId] = useState(saved.accessKeyId);
  const [secret, setSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [sessionToken, setSessionToken] = useState("");
  const [region, setRegion] = useState(saved.region);
  const [endpoint, setEndpoint] = useState(saved.endpoint);
  const [forcePathStyle, setForcePathStyle] = useState(saved.forcePathStyle);

  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  const loadProfiles = async () => {
    setProfiles(null);
    setProfilesError(null);
    try {
      const list = await api.listProfiles();
      setProfiles(list);
      setProfile((cur) => {
        if (cur && list.some((p) => p.name === cur && p.hasCredentials)) return cur;
        return list.find((p) => p.hasCredentials)?.name ?? "";
      });
    } catch (e) {
      setProfilesError(e as AppError);
      setProfiles([]);
    }
  };

  useEffect(() => {
    void loadProfiles();
  }, []);

  const canSubmit =
    !connecting &&
    (mode === "profile" ? !!profile : !!accessKeyId.trim() && !!secret.trim() && !!region.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const config: ConnectionConfig =
      mode === "profile"
        ? {
            kind: "profile",
            profile,
            region: profileRegion.trim() || null,
            endpoint: profileEndpoint.trim() || null,
          }
        : {
            kind: "static",
            accessKeyId: accessKeyId.trim(),
            secretAccessKey: secret.trim(),
            sessionToken: sessionToken.trim() || null,
            region: region.trim(),
            endpoint: endpoint.trim() || null,
            forcePathStyle: endpoint.trim() ? forcePathStyle : undefined,
          };
    setConnecting(true);
    setError(null);
    try {
      const info = await api.connect(config);
      const toSave: SavedConnection = {
        mode,
        profile,
        profileRegion: profileRegion.trim(),
        profileEndpoint: profileEndpoint.trim(),
        accessKeyId: accessKeyId.trim(),
        region: region.trim(),
        endpoint: endpoint.trim(),
        forcePathStyle,
      };
      writePref(PREF_KEY, toSave);
      setConnected(info);
    } catch (err) {
      setError(err as AppError);
      setConnecting(false);
    }
  };

  return (
    <div className="connect-screen">
      <div className="screen-corner">
        <SettingsButton />
      </div>
      <form className="connect-card" onSubmit={submit}>
        <div className="connect-head">
          <Logo size={40} />
          <div>
            <h1>S3 Explorer</h1>
            <p className="muted">Connect to Amazon S3 or any S3-compatible storage.</p>
          </div>
        </div>

        <div className="segmented" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "profile"}
            className={mode === "profile" ? "active" : ""}
            onClick={() => setMode("profile")}
          >
            <UserRound size={14} /> AWS profile
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "static"}
            className={mode === "static" ? "active" : ""}
            onClick={() => setMode("static")}
          >
            <KeyRound size={14} /> Access keys
          </button>
        </div>

        {mode === "profile" ? (
          <div className="connect-body">
            <div className="field-label-row">
              <span className="field-label">Profiles from ~/.aws</span>
              <button type="button" className="link-btn" onClick={() => void loadProfiles()}>
                <RefreshCw size={12} /> Reload
              </button>
            </div>
            <div className="profile-list" role="radiogroup">
              {profiles === null &&
                [0, 1, 2].map((i) => <div key={i} className="profile-row skeleton" />)}
              {profiles?.length === 0 && (
                <div className="empty-note">
                  {profilesError ? profilesError.message : "No profiles found. Use access keys instead."}
                </div>
              )}
              {profiles?.map((p) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={profile === p.name}
                  key={p.name}
                  disabled={!p.hasCredentials}
                  className={`profile-row ${profile === p.name ? "selected" : ""}`}
                  onClick={() => setProfile(p.name)}
                  onDoubleClick={(e) => {
                    setProfile(p.name);
                    (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
                  }}
                  title={p.hasCredentials ? undefined : "No credentials found for this profile"}
                >
                  <span className="radio-dot" />
                  <span className="profile-name">{p.name}</span>
                  {!p.hasCredentials && <span className="profile-note">no credentials</span>}
                  <span className="region-chip">{p.region ?? "default region"}</span>
                </button>
              ))}
            </div>

            <button type="button" className="disclosure" onClick={() => setShowAdvanced((v) => !v)}>
              <ChevronRight size={14} className={showAdvanced ? "rot90" : ""} /> Advanced
            </button>
            {showAdvanced && (
              <div className="grid-2">
                <label className="field">
                  <span className="field-label">Region override</span>
                  <input value={profileRegion} onChange={(e) => setProfileRegion(e.target.value)} placeholder="from profile" spellCheck={false} />
                </label>
                <label className="field">
                  <span className="field-label">Custom endpoint</span>
                  <input value={profileEndpoint} onChange={(e) => setProfileEndpoint(e.target.value)} placeholder="https://…" spellCheck={false} />
                </label>
              </div>
            )}
          </div>
        ) : (
          <div className="connect-body">
            <label className="field">
              <span className="field-label">Access key ID</span>
              <input
                value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value)}
                placeholder="AKIA…"
                autoComplete="off"
                spellCheck={false}
                className="mono"
              />
            </label>
            <label className="field">
              <span className="field-label">Secret access key</span>
              <div className="input-affix">
                <input
                  type={showSecret ? "text" : "password"}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="mono"
                />
                <button type="button" className="icon-btn" onClick={() => setShowSecret((v) => !v)} aria-label={showSecret ? "Hide secret" : "Show secret"}>
                  {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </label>
            <label className="field">
              <span className="field-label">
                Session token <span className="optional">optional</span>
              </span>
              <input value={sessionToken} onChange={(e) => setSessionToken(e.target.value)} autoComplete="off" spellCheck={false} className="mono" />
            </label>
            <div className="grid-2">
              <label className="field">
                <span className="field-label">Region</span>
                <input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1" spellCheck={false} />
              </label>
              <label className="field">
                <span className="field-label">
                  Endpoint <span className="optional">MinIO, R2…</span>
                </span>
                <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://…" spellCheck={false} />
              </label>
            </div>
            <label className={`check ${endpoint.trim() ? "" : "disabled"}`}>
              <input
                type="checkbox"
                checked={forcePathStyle}
                disabled={!endpoint.trim()}
                onChange={(e) => setForcePathStyle(e.target.checked)}
              />
              <Server size={13} />
              Force path-style addressing
            </label>
            <p className="hint">Secrets stay in memory and are never saved to disk by the UI.</p>
          </div>
        )}

        {error && (
          <div className="form-error">
            <AlertCircle size={15} />
            <span>{error.message}</span>
          </div>
        )}

        <button type="submit" className="btn btn-primary btn-block" disabled={!canSubmit}>
          {connecting ? <Loader2 size={15} className="spin" /> : null}
          {connecting ? "Connecting…" : "Connect"}
        </button>
      </form>
    </div>
  );
}
