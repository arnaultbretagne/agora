/**
 * Inline SVG, ported from the OLD UI. Inline rather than an icon font or a sprite sheet for the
 * reason every other asset decision here goes the same way: no runtime dependency, and no second
 * network request between the shell painting and the shell looking finished.
 *
 * Every glyph is `stroke="currentColor"`, so colour and theme come from CSS alone and none of these
 * need re-rendering when the theme flips.
 */

const stroke = (size: number, inner: string, viewBox = '0 0 24 24'): string =>
  `<svg width="${size}" height="${size}" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`

export const icons = {
  brand: (size: number): string =>
    `<svg width="${size}" height="${size}" viewBox="8 11 84 84" fill="none" aria-hidden="true"><g fill="currentColor"><rect x="16" y="19" width="68" height="6.5" rx="2"/><rect x="21" y="27.5" width="58" height="5.5" rx="2"/></g><path fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" d="M28 39V85.5M39 39V76M50 39V72.3M61 39V76.9M72 39V67.5"/></svg>`,
  menu: (size: number): string => stroke(size, '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>'),
  x: (size: number): string => stroke(size, '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  plus: (size: number): string => stroke(size, '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  search: (size: number): string => stroke(size, '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  star: (size: number, filled = false): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  shield: (size: number): string => stroke(size, '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  chevronDown: (size: number): string => stroke(size, '<polyline points="6 9 12 15 18 9"/>'),
  chevronLeft: (size: number): string => stroke(size, '<polyline points="15 18 9 12 15 6"/>'),
  send: (size: number): string => stroke(size, '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>'),
  check: (size: number): string => stroke(size, '<polyline points="20 6 9 17 4 12"/>'),
  trash: (size: number): string =>
    stroke(size, '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  message: (size: number): string => stroke(size, '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  sun: (size: number): string =>
    stroke(
      size,
      '<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.9" y1="4.9" x2="6.3" y2="6.3"/><line x1="17.7" y1="17.7" x2="19.1" y2="19.1"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.9" y1="19.1" x2="6.3" y2="17.7"/><line x1="17.7" y1="6.3" x2="19.1" y2="4.9"/>',
    ),
  /** Power symbol — "stop this Runtime", the manual twin of the idle reaper. */
  power: (size: number): string => stroke(size, '<path d="M12 3v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>'),
  moon: (size: number): string => stroke(size, '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
}
