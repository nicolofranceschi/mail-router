import type { ReactNode } from "react";

import type { Tone } from "./format";

function Svg({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const envelope = (
  <>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="m3.5 7.5 8.5 6 8.5-6" />
  </>
);

export const NAV_ICONS: Record<string, ReactNode> = {
  panoramica: (
    <Svg>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </Svg>
  ),
  regole: (
    <Svg>
      <circle cx="5.5" cy="6" r="2.5" />
      <circle cx="5.5" cy="18" r="2.5" />
      <circle cx="18.5" cy="12" r="2.5" />
      <path d="M8 6h2.5a3 3 0 0 1 3 3v0a3 3 0 0 0 2.5 3M8 18h2.5a3 3 0 0 0 3-3v0a3 3 0 0 1 2.5-3" />
    </Svg>
  ),
  attivita: (
    <Svg>
      <path d="M3 12h4l3 7.5 4-15 3 7.5h4" />
    </Svg>
  ),
  posta: <Svg>{envelope}</Svg>,
  dati: (
    <Svg>
      <ellipse cx="12" cy="5.5" rx="8" ry="2.5" />
      <path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13" />
      <path d="M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" />
    </Svg>
  ),
  caselle: (
    <Svg>
      <path d="M3 13.5 5.5 5.5A2 2 0 0 1 7.4 4h9.2a2 2 0 0 1 1.9 1.5L21 13.5V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3 13.5h5l1.5 2.5h5l1.5-2.5h5" />
    </Svg>
  ),
  utenti: (
    <Svg>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.6.8 2.7 2.6 3 5.2" />
    </Svg>
  ),
  impostazioni: (
    <Svg>
      <path d="M3.5 7H13M18 7h2.5M3.5 17H6M11 17h9.5" />
      <circle cx="15.5" cy="7" r="2.5" />
      <circle cx="8.5" cy="17" r="2.5" />
    </Svg>
  ),
};

export function LogoutIcon() {
  return (
    <Svg size={14}>
      <path d="M9 21H5.5A2.5 2.5 0 0 1 3 18.5v-13A2.5 2.5 0 0 1 5.5 3H9M16 17l5-5-5-5M21 12H9" />
    </Svg>
  );
}

export function BrandMark() {
  return (
    <div className="brand-mark">
      <Svg size={15}>{envelope}</Svg>
    </div>
  );
}

export function StatusIcon({ tone }: { tone: Tone }) {
  return (
    <Svg size={20}>
      {tone === "ok" ? <path d="m5 12.5 4.5 4.5L19 7.5" /> : null}
      {tone === "err" || tone === "warn" ? <path d="M12 5v9M12 18.5v.5" /> : null}
      {tone === "info" ? <path d="M12 19v-8M12 5.5V5" /> : null}
    </Svg>
  );
}
