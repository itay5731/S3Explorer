// Desktop notifications for work that finishes while the user is in another window.

import * as api from "../lib/api";
import { useSettings } from "./settings";

/** Does the app window have focus? Asks the OS window; the document's focus only if that fails. */
async function windowFocused(): Promise<boolean> {
  try {
    return await api.isWindowFocused();
  } catch {
    return document.hasFocus();
  }
}

/** Show an OS notification, unless the app window has focus or the setting is off. */
export function notifyInBackground(title: string, body?: string) {
  if (!useSettings.getState().settings?.notifyOnFinish) return;
  void windowFocused().then((focused) => {
    if (focused) return;
    // A courtesy only: if the OS refuses it, the toast and the Activity panel still report the result.
    api.notify(title, body).catch(() => {});
  });
}
