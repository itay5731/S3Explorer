export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className="logo" aria-hidden="true">
      <defs>
        <linearGradient id="s3x-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-2)" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="url(#s3x-g)" />
      <ellipse cx="16" cy="10.5" rx="8" ry="3" fill="none" stroke="#fff" strokeWidth="1.8" />
      <path d="M8 10.5v11c0 1.7 3.6 3 8 3s8-1.3 8-3v-11" fill="none" stroke="#fff" strokeWidth="1.8" />
      <path d="M8 16c0 1.7 3.6 3 8 3s8-1.3 8-3" fill="none" stroke="#fff" strokeWidth="1.8" opacity=".7" />
    </svg>
  );
}
