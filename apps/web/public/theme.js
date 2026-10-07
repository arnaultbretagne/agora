// The theme before the first paint (src/screen/shell.tsx, useTheme): the one picked, else the system's.
// Without it, a dark page would show light until the client runs, and the bars would be coloured light.
;(function () {
  var picked = null
  try {
    picked = localStorage.getItem('agora:theme')
  } catch (e) {
    // For this page only.
  }
  var dark = picked === 'dark' || (picked !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
})()
