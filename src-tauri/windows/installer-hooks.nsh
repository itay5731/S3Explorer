; NSIS installer hooks (bundle.windows.nsis.installerHooks in tauri.conf.json).
;
; An upgrade replaces s3explorer.exe at the same path, and the Start menu, desktop and pinned
; taskbar shortcuts keep pointing at that path. Explorer caches the icon per path, so without a
; change notification it keeps showing the icon of the version that was installed first.
; Tell the shell the executable changed, then that file associations/icons changed, so it re-reads
; the icon from the new executable. Runs for every install, including in-app updates (/UPDATE).

!define S3E_SHCNE_UPDATEITEM 0x00002000
!define S3E_SHCNE_ASSOCCHANGED 0x08000000
!define S3E_SHCNF_IDLIST 0x0000
!define S3E_SHCNF_PATHW 0x0005
!define S3E_SHCNF_FLUSH 0x1000

!macro NSIS_HOOK_POSTINSTALL
  System::Call 'shell32::SHChangeNotify(i ${S3E_SHCNE_UPDATEITEM}, i ${S3E_SHCNF_PATHW}|${S3E_SHCNF_FLUSH}, w "$INSTDIR\${MAINBINARYNAME}.exe", p 0)'
  System::Call 'shell32::SHChangeNotify(i ${S3E_SHCNE_ASSOCCHANGED}, i ${S3E_SHCNF_IDLIST}|${S3E_SHCNF_FLUSH}, p 0, p 0)'
!macroend
