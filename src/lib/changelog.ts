// The patch notes shipped inside the app: CHANGELOG.md is bundled at build time, so "What's new"
// after an update works offline and always matches the version that is running.

import changelog from "../../CHANGELOG.md?raw";

/** The `## [X.Y.Z]` section of the bundled changelog as markdown, or null when there is none. */
export function releaseNotes(version: string, source: string = changelog): string | null {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const heading = `## [${version}]`;
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## [")) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join("\n").trim();
  return body || null;
}
