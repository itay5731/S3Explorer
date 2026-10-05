// Desktop notifications for work that finishes while the user is in another window.

import * as api from "../lib/api";
import { useSettings } from "./settings";

/** Show an OS notification, unless the app window has focus or the setting is off. */
export function notifyInBackground(title: string, body?: string) {
  if (document.hasFocus()) return;
  if (!useSettings.getState().settings?.notifyOnFinish) return;
  // A courtesy only: if the OS refuses it, the toast and the Activity panel still report the result.
  api.notify(title, body).catch(() => {});
}
