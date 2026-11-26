// The access picker (docs/specs/assistant-ui.md, "Access"): a key alone on the composer, and a menu of the
// rights the agent is given beyond its harness's own service, one line each, ticked on and off where it is:
// the Internet, GitHub, the vault, k8s, agora, then anything else offered.
import { CheckIcon, KeyRoundIcon, MinusIcon } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import type { FC } from 'react'
import { cn } from '@/lib/utils'
import { useAgora } from '../agora/runtime.tsx'
import { accessEntries, accessState, accessTitle } from '../agora/view.ts'
import { below, fitted, iconButton, menuContentClass, menuItemClass } from './picker.ts'

/** The key alone; its name and its tooltip say what is granted. The menu stays open from one choice to the next. */
export const AccessPicker: FC = () => {
  const { offered, access, chooseAccess, composer, view } = useAgora()
  const entries = accessEntries(offered)
  if (entries.length === 0) return null
  const closed = !composer.create && (composer.running || composer.uncertain !== null || view.state === 'stopped' || view.state === 'lost')
  const title = accessTitle(access, entries)
  const granted = entries.some((entry) => accessState(access, entry) !== 'off')
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={closed}>
        <button type="button" aria-label={`Access: ${title}`} title={title} className={iconButton}>
          {/* The key alone: coral once anything is granted. */}
          <KeyRoundIcon className={cn('size-4', granted && 'text-primary')} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content {...below} aria-label="Access" className={cn(menuContentClass, fitted)}>
          {entries.map((e) => {
            const state = accessState(access, e)
            return (
              <DropdownMenu.CheckboxItem
                key={e.key}
                checked={state === 'partial' ? 'indeterminate' : state === 'on'}
                // Partly granted, as a role's card may leave it: ticked, it gives the whole entry.
                onCheckedChange={() => chooseAccess(e, state !== 'on')}
                onSelect={(event) => event.preventDefault()}
                className={cn(menuItemClass, 'pr-4')}
              >
                {state === 'partial' ? <MinusIcon className="mt-0.5 size-3.5 shrink-0" /> : <CheckIcon className={cn('mt-0.5 size-3.5 shrink-0', state === 'on' ? 'opacity-100' : 'opacity-0')} />}
                <span className="flex min-w-0 flex-col">
                  <span>{e.name}</span>
                  {e.detail && <span className="text-muted-foreground truncate text-[12px]">{e.detail}</span>}
                </span>
              </DropdownMenu.CheckboxItem>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
