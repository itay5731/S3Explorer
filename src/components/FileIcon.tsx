import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Database,
  type LucideIcon,
} from "lucide-react";
import { extension } from "../lib/format";

type Kind = "image" | "video" | "audio" | "archive" | "code" | "json" | "sheet" | "text" | "data" | "file";

const EXT: Record<string, Kind> = {};
const reg = (kind: Kind, exts: string) => exts.split(" ").forEach((e) => (EXT[e] = kind));
reg("image", "jpg jpeg png gif webp svg ico bmp tif tiff heic avif");
reg("video", "mp4 mov mkv webm avi m4v");
reg("audio", "mp3 wav flac aac ogg m4a");
reg("archive", "zip gz tgz tar bz2 xz 7z rar zst");
reg("code", "js ts tsx jsx css scss html htm py rs go java rb sh ps1 c cpp h sql xml yml yaml toml");
reg("json", "json ndjson");
reg("sheet", "csv tsv xls xlsx");
reg("text", "txt md log pdf doc docx rtf");
reg("data", "parquet avro orc db sqlite");

const ICONS: Record<Kind, LucideIcon> = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  archive: FileArchive,
  code: FileCode,
  json: FileJson,
  sheet: FileSpreadsheet,
  text: FileText,
  data: Database,
  file: File,
};

export function fileKind(name: string): Kind {
  return EXT[extension(name)] ?? "file";
}

export function FileIcon({ name, folder, size = 15 }: { name: string; folder?: boolean; size?: number }) {
  if (folder) return <Folder size={size} className="ficon ficon-folder" strokeWidth={1.75} />;
  const kind = fileKind(name);
  const Icon = ICONS[kind];
  return <Icon size={size} className={`ficon ficon-${kind}`} strokeWidth={1.75} />;
}
