// What the composer's pickers share (docs/specs/assistant-ui.md, "The pickers"): their buttons, where their
// lists open, and the lists' look.
import { cn } from '@/lib/utils'

export const menuContentClass =
  'bg-popover text-popover-foreground border-foreground/10 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 rounded-surface z-50 min-w-56 overflow-hidden border p-1'
export const menuItemClass =
  'hover:bg-muted focus:bg-muted flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-[13px] outline-none select-none'
export const quietButton = 'text-muted-foreground hover:text-foreground rounded-control h-7 px-2 text-[13px] transition-colors pointer-coarse:h-9'
/** A picker that shows its icon alone: square, its value in its accessible name and its tooltip. */
export const iconButton = cn(quietButton, 'grid w-7 shrink-0 place-items-center px-0 disabled:opacity-50 pointer-coarse:w-9')
/**
 * Where a picker's list opens: below its trigger, from its start; upward only where it does not fit below,
 * as at the foot of the screen.
 */
export const below = { side: 'bottom', align: 'start', sideOffset: 6, collisionPadding: 8 } as const
/** A list that keeps to the room it has: never wider than the screen, nor taller than the room. */
export const fitted = 'max-h-(--radix-dropdown-menu-content-available-height) max-w-[min(24rem,calc(100vw-1rem))] overflow-y-auto'
