// The part of the page the user sees (docs/specs/assistant-ui.md, "On a phone"). A phone's keyboard
// covers the page without resizing it, and iOS may scroll the page under it; the visual viewport says
// what is left. The screen is sized and placed on it (`--viewport-height`, `--viewport-top`), and while
// the keyboard is up (`data-keyboard`), the home indicator's margin goes: the composer rests on the keys.
import { useEffect } from 'react'

/** Taller than this, the difference is a keyboard, not a toolbar. */
const KEYBOARD = 120

export function useVisualViewport(): void {
  useEffect(() => {
    const visual = window.visualViewport
    if (!visual) return
    const root = document.documentElement
    const fit = () => {
      // Pinched to zoom: the page keeps its size.
      if (Math.abs(visual.scale - 1) > 0.01) return
      root.style.setProperty('--viewport-height', `${String(visual.height)}px`)
      root.style.setProperty('--viewport-top', `${String(visual.offsetTop)}px`)
      // The layout viewport's height: iOS keeps it when the keyboard comes up.
      root.toggleAttribute('data-keyboard', root.clientHeight - visual.height > KEYBOARD)
    }
    fit()
    visual.addEventListener('resize', fit)
    visual.addEventListener('scroll', fit)
    return () => {
      visual.removeEventListener('resize', fit)
      visual.removeEventListener('scroll', fit)
      root.style.removeProperty('--viewport-height')
      root.style.removeProperty('--viewport-top')
      root.removeAttribute('data-keyboard')
    }
  }, [])
}
