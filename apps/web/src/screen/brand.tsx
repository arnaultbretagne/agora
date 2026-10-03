// The first Agora's mark — a colonnade under its entablature — and its name, set in Newsreader.
import type { FC } from 'react'
import { cn } from '@/lib/utils'

export const BrandMark: FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="8 11 84 84" aria-hidden className={cn('text-primary shrink-0', className)}>
    <g fill="currentColor">
      <rect className="brand-architrave" x="16" y="19" width="68" height="6.5" rx="2" />
      <rect className="brand-echinus" x="21" y="27.5" width="58" height="5.5" rx="2" />
    </g>
    <path
      className="brand-columns"
      fill="none"
      stroke="currentColor"
      strokeWidth="4"
      strokeLinecap="round"
      d="M28 39V85.5M39 39V76M50 39V72.3M61 39V76.9M72 39V67.5"
    />
  </svg>
)

export const Wordmark: FC<{ className?: string }> = ({ className }) => (
  <span className={cn('font-brand text-[19px] leading-none font-normal tracking-[-0.4px]', className)}>Agora</span>
)
