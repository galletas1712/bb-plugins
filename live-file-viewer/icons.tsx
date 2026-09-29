// Local toolbar glyphs avoid depending on BB's evolving named-icon catalog.
// Keep the action names typed so an unknown icon fails compilation.
const paths = {
  Eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
  Code: ['m8 5-7 7 7 7', 'm16 5 7 7-7 7'],
  Columns2: ['M3 3h18v18H3z', 'M12 3v18'],
  Copy: ['M9 9h12v12H9z', 'M15 5V3H3v12h2'],
  Save: ['M4 3h13l4 4v14H3V3z', 'M7 3v6h9V3', 'M7 21v-8h10v8'],
  RotateCcw: ['M3 10a9 9 0 1 1 2 8', 'M3 3v7h7'],
  RefreshCw: ['M20 7a9 9 0 0 0-15-2L2 8', 'M2 2v6h6', 'M4 17a9 9 0 0 0 15 2l3-3', 'M22 22v-6h-6'],
  Maximize2: ['M8 3H3v5', 'M16 3h5v5', 'M21 16v5h-5', 'M8 21H3v-5'],
  Minimize2: ['M3 8h5V3', 'M16 3v5h5', 'M21 16h-5v5', 'M8 21v-5H3'],
  X: ['m6 6 12 12', 'M6 18 18 6'],
  Check: ['m4 12 5 5L20 6'],
  Lock: ['M5 10h14v11H5z', 'M8 10V6a4 4 0 0 1 8 0v4'],
  Circle: ['M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0'],
  Loading: ['M21 12a9 9 0 1 1-9-9'],
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name, className }: { name: IconName; className?: string }) {
  return <svg aria-hidden="true" focusable="false" data-viewer-icon={name} className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {paths[name].map((d, index) => <path key={index} d={d} />)}
  </svg>;
}
