import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { TreePreview } from './tree/TreePreview'
import './index.css'
import { TooltipProvider } from '@/components/ui/tooltip'

// The system's theme, followed live (no inline script: the page is served under a 'self'-only policy).
const dark = matchMedia('(prefers-color-scheme: dark)')
const applyTheme = () => document.documentElement.classList.toggle('dark', dark.matches)
applyTheme()
dark.addEventListener('change', applyTheme)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* The sub-streams preview by default; the earlier team-view catalogue at ?page=team. */}
    {new URLSearchParams(location.search).get('page') === 'team' ? <App /> : <TooltipProvider><TreePreview /></TooltipProvider>}
  </StrictMode>,
)
