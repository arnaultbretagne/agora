// A harness's mark, monochrome, for the composer when it is too narrow for names (harness-marks.ts). Any other
// harness, the mock included, gets a robot.
import { BotIcon } from 'lucide-react'
import type { FC } from 'react'
import { HARNESS_MARKS } from './harness-marks.ts'

export const HarnessMark: FC<{ harness: string | null | undefined; className?: string }> = ({ harness, className }) => {
  const mark = harness ? HARNESS_MARKS[harness] : undefined
  if (mark === undefined) return <BotIcon aria-hidden className={className} />
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" className={className}>
      <path d={mark} />
    </svg>
  )
}
