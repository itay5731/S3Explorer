/** The app mark: a storage bucket with a compass needle. Mirrors src-tauri/app-icon.svg. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className="logo" aria-hidden="true">
      <defs>
        <linearGradient id="s3x-g" x1=".1" y1="0" x2=".9" y2="1">
          <stop offset="0" stopColor="#4C8DFF" />
          <stop offset=".55" stopColor="#6D5CFF" />
          <stop offset="1" stopColor="#9B4DFF" />
        </linearGradient>
        <linearGradient id="s3x-n" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#FF8A4C" />
          <stop offset="1" stopColor="#FF4D6D" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="7.5" fill="url(#s3x-g)" />
      <path d="M6.6 11.4 9 24c.2 1.7 3.3 2.8 7 2.8s6.8-1.1 7-2.8l2.4-12.6z" fill="#fff" />
      <ellipse cx="16" cy="11.4" rx="9.4" ry="3.2" fill="#fff" />
      <ellipse cx="16" cy="11.4" rx="7.8" ry="2.2" fill="#3730A3" />
      <g transform="rotate(38 16 11.4)">
        <path d="M16 2.6l2.6 8.8h-5.2z" fill="url(#s3x-n)" />
        <path d="M16 20.2l2.6-8.8h-5.2z" fill="#4338CA" />
        <circle cx="16" cy="11.4" r="1.3" fill="#fff" />
      </g>
    </svg>
  );
}
