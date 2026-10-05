import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useToasts } from "../store/toasts";

const ICON = { success: CheckCircle2, error: XCircle, info: Info };

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICON[t.kind];
        return (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <Icon size={16} className="toast-icon" />
            <div className="toast-body">
              <div className="toast-title">{t.title}</div>
              {t.detail && <div className="toast-detail">{t.detail}</div>}
              {t.action && (
                <button
                  type="button"
                  className="link-btn toast-action"
                  onClick={() => {
                    dismiss(t.id);
                    t.action?.run();
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button className="icon-btn toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
