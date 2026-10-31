/**
 * Hand-drawn inline icons — no icon library, no external requests.
 * All 24x24, 1.6 stroke, currentColor, so they inherit text colour.
 */

type P = { className?: string };

const base = (className?: string) => ({
  viewBox: "0 0 24 24",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className: className ?? "h-5 w-5",
  "aria-hidden": true,
});

export const IconHome = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5.5 9.5V20h13V9.5" />
  </svg>
);

export const IconWave = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M3 12h2" />
    <path d="M7.5 8v8" />
    <path d="M12 4.5v15" />
    <path d="M16.5 8v8" />
    <path d="M21 12h-2" />
  </svg>
);

export const IconVideo = ({ className }: P) => (
  <svg {...base(className)}>
    <rect x="3" y="6" width="12" height="12" rx="2.5" />
    <path d="m15 10.5 5.2-2.6a.6.6 0 0 1 .8.6v7a.6.6 0 0 1-.8.6L15 13.5" />
  </svg>
);

/** AI video: a film frame with a spark — generated, not recorded. */
export const IconFilmSpark = ({ className }: P) => (
  <svg {...base(className)}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M7 5v14M3 9h4M3 15h4" />
    <path d="M14.5 9.2v5.6M11.7 12h5.6" />
  </svg>
);

export const IconMic = ({ className }: P) => (
  <svg {...base(className)}>
    <rect x="9" y="3" width="6" height="10" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
    <path d="M12 18v3" />
  </svg>
);

export const IconScript = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M6 3h9l4 4v14H6z" />
    <path d="M14.5 3v4.5H19" />
    <path d="M9 12h6M9 16h4" />
  </svg>
);

export const IconSparkle = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    <path d="M18.5 15.5 19 17l1.5.5-1.5.5-.5 1.5-.5-1.5L16.5 17l1.5-.5z" />
  </svg>
);

export const IconDownload = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M12 3v11" />
    <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
    <path d="M4 20h16" />
  </svg>
);

export const IconImage = ({ className }: P) => (
  <svg {...base(className)}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <circle cx="8.75" cy="9.75" r="1.6" />
    <path d="m4 16.5 4.5-4 3.5 3 3-2.5 5 4" />
  </svg>
);

export const IconUpload = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M12 16V5" />
    <path d="m7.5 8.5 4.5-4 4.5 4" />
    <path d="M4 20h16" />
  </svg>
);

export const IconPlay = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M8 5.5v13l11-6.5z" />
  </svg>
);

export const IconPause = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M9 5v14M15 5v14" />
  </svg>
);

export const IconRefresh = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9" />
    <path d="M20 4.5V10h-5.5" />
  </svg>
);

export const IconEdit = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" />
    <path d="M14.5 6.5l3 3" />
  </svg>
);

export const IconCheck = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);

export const IconX = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const IconSettings = ({ className }: P) => (
  <svg {...base(className)}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 3v2.4M12 18.6V21M21 12h-2.4M5.4 12H3M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7M18.4 18.4l-1.7-1.7M7.3 7.3 5.6 5.6" />
  </svg>
);

export const IconLink = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 1 0-5.7-5.7l-1.3 1.3" />
    <path d="M14 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 1 0 5.7 5.7l1.3-1.3" />
  </svg>
);

export const IconArrowRight = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M4 12h15" />
    <path d="m13.5 6.5 6 5.5-6 5.5" />
  </svg>
);

export const IconClock = ({ className }: P) => (
  <svg {...base(className)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

export const IconTrash = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M4.5 7h15" />
    <path d="M9.5 7V5h5v2" />
    <path d="M6.5 7l.8 12.2h9.4L17.5 7" />
  </svg>
);

export const IconAlert = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M12 4.5 21 19H3z" />
    <path d="M12 10v4M12 16.6v.4" />
  </svg>
);

export const IconKey = ({ className }: P) => (
  <svg {...base(className)}>
    <circle cx="8" cy="12" r="4" />
    <path d="M12 12h9" />
    <path d="M17.5 12v3.5" />
    <path d="M20.5 12v2.5" />
  </svg>
);

export const IconServer = ({ className }: P) => (
  <svg {...base(className)}>
    <rect x="3.5" y="4" width="17" height="6.5" rx="2" />
    <rect x="3.5" y="13.5" width="17" height="6.5" rx="2" />
    <path d="M7.5 7.25h.01M7.5 16.75h.01" />
  </svg>
);
