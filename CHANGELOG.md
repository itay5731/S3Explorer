# Changelog

Patch notes for every release. Versions are tagged `vMAJOR.MINOR.PATCH`.
The section for a version becomes the text of its GitHub Release.

## [Unreleased]

### New

- **A new look.** A marigold accent on neutral surfaces in both themes, new typefaces, and a new icon with a white bucket on a yellow tile.
- **A start screen for your connections.** Saved connections are tiles: drag them into the order you want, right-click one for Connect, Edit and Delete, and scroll a page of six at a time when you have more. Behind them, pulses travel from small servers into your connections.
- **Newest files.** The lower part of the sidebar lists the files most recently changed in the open bucket, wherever they are, with the folder each one is in. Narrow the list to the last hour, 24 hours or 7 days, to chosen file types, or by searching. Click a file to open its folder, or download it directly. It looks again by itself after an upload. The scan looks at up to 20,000 files and says so when it stops there.
- **Desktop notifications** when your transfers are done, or a copy, move or delete finishes, while the app is in the background. Turn them off in Settings under Notifications.
- **Switch between light and dark from the top bar**, without opening Settings.
- **The window title shows the connection** you are in.
- **A hidden game.** Click a server on the start screen five times: your first connection moves to the middle and the servers defend it against bugs, power surges, worms, ransomware and a DDoS boss. Esc leaves.
- **Resizable sidebar.** Drag its right edge to set the width, and the divider between the buckets and Newest files to set how the height is shared. Double-click either to reset.
- **Accent colour** in Settings under Appearance: yellow, green, blue or red. Folder icons follow it.
- **Size and text weight** sliders in Settings under Appearance. Size scales the whole window, text and icons together.

### Improved

- **New connections are saved by default**, under a suggested name if you do not type one. Untick the box to connect without saving.
- **The details panel leads with size, date and path.** Storage class, ETag, content type and metadata are under "More details".
- **Before a bucket is open**, the main area explains what to do next instead of showing a disabled toolbar.
- **The logo in the top bar** takes you back to your connections.
- **Copy the current path** with the button at the end of the path bar.
- On a large window the side panels are wider.

## [0.3.0] - 2026-10-05

Manage your files, not just look at them. This version adds delete, rename, copy and move, saved connections, a theme switch, in-app updates and a new icon.

### New

- **Delete, rename, copy and move** for objects and folders, within a bucket or between buckets. Use the right-click menu, the toolbar, or the keyboard: `Delete`, `F2`, `Ctrl+C`, `Ctrl+X`, `Ctrl+V`.
  - Before anything is deleted, moved or overwritten you get a confirmation that lists the exact keys and how many objects and bytes are affected.
  - If something already exists at the destination you choose: skip it or overwrite it. Nothing is overwritten unless you pick that.
  - These run in the background and show up in the bottom panel, now called **Activity**, next to your transfers, with progress, cancel, and a list of anything that failed.
- **Saved connections.** Save an AWS profile or access keys under a name and connect with one click. Secret keys go into your operating system's keychain, never into a file.
- **Light, dark or system theme**, in Settings under Appearance.
- **Updates from inside the app.** Settings has an Updates tab: check for a new version, read its patch notes, and install it. You can also have the app check when it starts. Only updates signed by this project are installed.
- **A new icon.**

### Improved

- **Downloads use far less memory with large parts.** Parts are written to disk as they arrive. With 100 MiB parts and 32 in parallel, memory dropped from about 3.2 GiB to about 100 MiB, and large-part downloads got faster on fast disks.
- **A dropped connection no longer restarts a part.** The download resumes from where it stopped, and the progress bar no longer jumps backwards.
- **Sizes and speeds are labelled correctly** as KiB, MiB, GiB and MiB/s. The numbers were always binary; the labels said MB and GB.
- The memory estimate in Settings matches the new behavior.

### Fixed

- **Uploads on slow connections failed after 30 seconds.** A timeout wrongly counted the time spent sending the file.
- Small downloads are now flushed to disk before they are marked complete.
- A download that keeps getting cut off now gives up with an error instead of retrying forever, and an upload whose connection silently dies no longer waits forever.

### How move and delete keep your data safe

S3 has no real move or rename, so the app copies and then deletes the original. It does that carefully:

- An original is deleted only after its own copy is confirmed, and not if the original changed in the meantime.
- A cancelled or failed move leaves every object in exactly one place.
- A request that would write into its own source, such as moving a folder into itself, is refused.
- Keys are never altered: spaces, unicode and unusual characters are sent exactly as they are.

### Good to know

- Updating from 0.2.0 to this version is still a manual download. In-app updates work from this version onward.
- On Windows, an in-app update installs the app. If you run the standalone exe, download the new one instead.
- On Linux, saving a connection with a secret needs a keyring service such as GNOME Keyring or KWallet.
- Disconnecting does not stop transfers or file operations that are already running; they finish in the background.
- On versioned buckets, delete adds a delete marker and older versions remain.
- Archived objects (Glacier, Deep Archive) cannot be copied or moved until restored.
- Copies keep content type, metadata, storage class and tags. They do not keep ACLs.
- Delete, rename, copy and move have been tested thoroughly against a local S3 server, but not yet against real AWS. macOS and Linux builds are still untried by a human.

## [0.2.0] - 2026-10-05

Settings. You can now tune how transfers run instead of living with fixed numbers.

### New

- **Settings dialog**, opened with the gear button on the connect screen or in the top bar. It works before you connect.
- **Part size**: Auto, or a custom size from 1 to 256 MiB. Auto is what the app did before: 8 MiB parts, and 16 MiB for downloads over 1 GiB.
- **Parallel parts per transfer**: 1 to 32 (default 8).
- **Simultaneous transfers**: 1 to 10 (default 4). The rest wait in a queue.
- **Live impact summary** while you edit: total connections, estimated peak download memory, and how many parts a 1 GiB file would be split into. It warns you when the memory estimate gets large.
- Settings are saved on your machine and survive restarts. A missing or damaged settings file falls back to defaults instead of breaking startup.

### How changes apply

- Part size and parallel parts apply to transfers that start after you save. Transfers already running keep the values they started with.
- The simultaneous-transfers limit applies to the queue immediately. Raising it starts queued transfers right away. Lowering it never interrupts a running transfer.
- Uploads always use parts of at least 5 MiB, because S3 requires it. A smaller custom size still applies to downloads.

### Changed

- Queued transfers now start strictly in the order they were added.
- An object is downloaded in a single request when it is no larger than one part.

### Fixed

- The transfers panel could briefly show one more running transfer than the limit while one finished and the next started.

## [0.1.0] - 2026-10-05

The first working version. Vibe coded, so I won't have to pay for an S3 explorer. :)

### What you can do

- **Connect** with an AWS profile from `~/.aws` or with access keys. Add a custom endpoint to use MinIO, Cloudflare R2, SeaweedFS, LocalStack and other S3-compatible storage.
- **List buckets**, including ones in other regions.
- **Browse folders and objects** with size, last modified, storage class, ETag, content type and user metadata. The table stays smooth with thousands of rows and loads more as you scroll.
- **Download in parallel parts.** Objects over 8 MiB are split into 8 MiB byte ranges (16 MiB for objects over 1 GiB) and fetched up to 8 parts at a time.
- **Upload** by button or drag and drop, with multipart upload for files over 8 MiB.
- **Create folders** and **delete folders** recursively, with a confirmation that shows the exact prefix.
- **Transfers panel** with live speed, parts done, time remaining, cancel, and "show in folder". Up to 4 transfers run at once and the rest queue.
- Sort, filter, multi-select, right-click menu, keyboard navigation, dark and light themes.

### Built to be careful with your data

- A download fails instead of mixing two versions if the object changes midway, and received bytes are checked against the expected size.
- File names from S3 are sanitized before they become local paths, so a hostile key can't write outside the folder you chose.
- Two downloads can't write to the same file at the same time.
- Stalled connections time out and the affected part is retried.
- Cancelled or failed multipart uploads are aborted, so they don't linger and cost you storage.
- Your secret key is never written to disk by the app.

### Known limitations

- Not yet tested against real AWS S3, only against a local S3-compatible server.
- macOS and Linux builds are produced by CI and have not been tried by a human.
- No deleting or renaming of single objects, no copy or move, no bucket creation, no versioning or presigned URLs.
- Part size and concurrency are fixed. Settings for them are coming in the next version.
- Dropping a folder onto the window does not upload it recursively.
