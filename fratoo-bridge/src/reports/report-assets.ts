import { readFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Chart.js, its date adapter and the report's web fonts, inlined into the
 * report so it is one self-contained file: the PDF renderer (Gotenberg) never
 * fetches anything, and a downloaded report works offline. Read from
 * node_modules once and cached.
 */
export interface ReportAssets {
  /** @font-face rules with the woff2 files as data: URIs. */
  fontCss: string;
  /** chart.js UMD + chartjs-adapter-date-fns bundle (date-fns included). */
  chartJs: string;
}

let cached: ReportAssets | null = null;

const FONTS: { family: string; pkg: string; file: string; weight: number }[] = [
  { family: 'IBM Plex Sans', pkg: '@fontsource/ibm-plex-sans', file: 'ibm-plex-sans-latin-400-normal.woff2', weight: 400 },
  { family: 'IBM Plex Sans', pkg: '@fontsource/ibm-plex-sans', file: 'ibm-plex-sans-latin-500-normal.woff2', weight: 500 },
  { family: 'IBM Plex Sans', pkg: '@fontsource/ibm-plex-sans', file: 'ibm-plex-sans-latin-600-normal.woff2', weight: 600 },
  { family: 'IBM Plex Sans', pkg: '@fontsource/ibm-plex-sans', file: 'ibm-plex-sans-latin-700-normal.woff2', weight: 700 },
  { family: 'IBM Plex Mono', pkg: '@fontsource/ibm-plex-mono', file: 'ibm-plex-mono-latin-500-normal.woff2', weight: 500 },
  { family: 'Outfit', pkg: '@fontsource/outfit', file: 'outfit-latin-700-normal.woff2', weight: 700 },
];

export function reportAssets(): ReportAssets {
  if (cached) return cached;

  const fontCss = FONTS.map(({ family, pkg, file, weight }) => {
    const data = readFileSync(require.resolve(`${pkg}/files/${file}`)).toString('base64');
    return `@font-face { font-family: '${family}'; font-style: normal; font-weight: ${weight}; font-display: block; src: url(data:font/woff2;base64,${data}) format('woff2'); }`;
  }).join('\n');

  // Both packages' "main" lives in their dist/ folder, next to the browser bundles.
  const chartDist = dirname(require.resolve('chart.js'));
  const adapterDist = dirname(require.resolve('chartjs-adapter-date-fns'));
  const chartJs = [
    readFileSync(join(chartDist, 'chart.umd.js'), 'utf8'),
    readFileSync(join(adapterDist, 'chartjs-adapter-date-fns.bundle.min.js'), 'utf8'),
  ]
    .join(';\n')
    // Never let a "</script" inside the bundles close the inline <script> early.
    .replace(/<\/script/gi, '<\\/script');

  cached = { fontCss, chartJs };
  return cached;
}
