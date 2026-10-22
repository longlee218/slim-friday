// Authored 16px icons, one stroke weight, drawn in currentColor.
const PATHS = {
  back: <path d="M10 3 5 8l5 5" />,
  next: <path d="m6 3 5 5-5 5" />,
  reply: <path d="M6.5 3.5 2.5 7.5l4 4M2.5 7.5H9a4.5 4.5 0 0 1 4.5 4.5v.5" />,
  image: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <circle cx="6" cy="6.5" r="1.2" />
      <path d="m2.5 12 3.8-3.8 2.7 2.7 1.8-1.8 2.7 2.7" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.2V11M8 5h.01" />
    </>
  ),
  up: <path d="M8 13V3M4 7l4-4 4 4" />,
  stop: <rect x="5" y="5" width="6" height="6" rx="1" fill="currentColor" />,
  shield: <path d="M8 1.8 3 3.8v4c0 3 2.2 5.2 5 6.4 2.8-1.2 5-3.4 5-6.4v-4z" />,
  doc: (
    <>
      <path d="M4 1.8h5l3 3V14H4z" />
      <path d="M9 1.8V5h3M6 8.5h4M6 11h4" />
    </>
  ),
  run: <path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.8M2.8 2.5v2.7h2.7" />,
  question: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1M8 11.2h.01" />
    </>
  ),
  download: <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />,
  arrow: <path d="M3 8h10M9 4l4 4-4 4" />,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  x: <path d="m4 4 8 8M12 4l-8 8" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3l2 1.5" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </>
  ),
  sidebar: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2.5" />
      <path d="M6 2.5v11" />
    </>
  ),
  compose: (
    <>
      <path d="M13.5 8.5v4a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12.5V4A1.5 1.5 0 0 1 4 2.5h4" />
      <path d="M11.8 1.8a1.3 1.3 0 0 1 1.9 1.9L8.5 9 6 9.6l.6-2.5z" />
    </>
  ),
  clip: (
    <path d="M13 7.5 8 12.5a3 3 0 0 1-4.3-4.3l5.3-5.3a2 2 0 0 1 2.9 2.9L6.6 11a1 1 0 0 1-1.4-1.4L10 4.8" />
  ),
  retry: <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8M13.2 2.5v2.7h-2.7" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1" />
    </>
  ),
  moon: <path d="M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7z" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r="0.6" fill="currentColor" />
      <circle cx="8" cy="8" r="0.6" fill="currentColor" />
      <circle cx="12.5" cy="8" r="0.6" fill="currentColor" />
    </>
  ),
  pencil: <path d="M10.8 2.7a1.4 1.4 0 0 1 2 2L5.5 12 2.8 12.7l.7-2.7z" />,
  trash: <path d="M2.8 4.2h10.4M6.2 4.2V2.8h3.6v1.4M4.2 4.2l.6 9h6.4l.6-9M6.8 6.8v4M9.2 6.8v4" />,
  unread: <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />,
  read: <circle cx="8" cy="8" r="3" />,
  person: (
    <>
      <circle cx="8" cy="5.3" r="2.6" />
      <path d="M2.8 13.5a5.2 5.2 0 0 1 10.4 0" />
    </>
  ),
  people: (
    <>
      <circle cx="6" cy="5.5" r="2.3" />
      <path d="M1.8 13.2a4.2 4.2 0 0 1 8.4 0M10.3 3.4a2.3 2.3 0 0 1 0 4.4M11.6 9.3a4.2 4.2 0 0 1 2.6 3.9" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
