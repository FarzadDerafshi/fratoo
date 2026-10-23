// The Fratoo mark (flask of beer + %), same geometry as public/favicon.svg
// and icons/*.svg. Outline and % use currentColor so the mark follows the
// theme (navy on light, near-white on dark); the beer stays amber.

export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size * 1.06} height={size} viewBox="0 0 106 100" aria-hidden="true" className="logo-mark">
      <defs>
        <linearGradient id="fratoo-beer" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFD84D" />
          <stop offset="1" stopColor="#C98A0B" />
        </linearGradient>
      </defs>
      <path
        d="M22 51 C28 46 34 47 40 49 C46 51 52 50 58 47 C62 45 66 46 68 50 C72 58 72 70 66 80 C62 87 56 91 50 91 H24 C15 91 10 83 14 75 Z"
        fill="url(#fratoo-beer)"
      />
      <circle cx="34" cy="63.5" r="5" fill="#FFFFFF" />
      <circle cx="47" cy="76.5" r="4.3" fill="#FFFFFF" />
      <g fill="none" stroke="currentColor" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M29 5 H61" />
        <path d="M36 9 V25 L8 70 C3 79 9 92 22 92 H58" />
        <path d="M53 9 V25 L66 43" />
        <path d="M76 75 L100 42" strokeWidth="5.5" />
      </g>
      <circle cx="79" cy="48" r="5.5" fill="currentColor" />
      <circle cx="97" cy="69.5" r="6" fill="currentColor" />
    </svg>
  );
}

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <span className="logo">
      <LogoMark size={size} />
      <span className="logo-word" style={{ fontSize: size * 0.8 }}>
        Fratoo
      </span>
    </span>
  );
}
