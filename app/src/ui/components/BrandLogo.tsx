/**
 * Procure Copilot brand mark — an inline, self-contained SVG so it needs no asset pipeline and
 * inherits crisp rendering at any size. A rounded red badge with a rupee glyph and an upward
 * "savings" spark, echoing the product promise: spend less, move fast. Presentational only.
 */

export interface BrandLogoProps {
  /** Pixel size of the square mark. */
  readonly size?: number;
  /** Optional className passthrough (e.g. for the header mark wrapper). */
  readonly className?: string;
  /** Accessible label; omit to render decorative (aria-hidden). */
  readonly title?: string;
}

export function BrandLogo({ size = 32, className, title }: BrandLogoProps): JSX.Element {
  const gradientId = "pc-logo-grad";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ff6b73" />
          <stop offset="100%" stopColor="#e23744" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="48" height="48" rx="13" fill={`url(#${gradientId})`} />
      {/* Rupee glyph */}
      <path
        d="M18 14h12M18 20h12M27 14c0 5-4 7-9 7 4 0 9 3 9 8l-1 5"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Savings spark (upward arrow) */}
      <path
        d="M33 31l4-4 4 4M37 27v9"
        fill="none"
        stroke="#34d399"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
