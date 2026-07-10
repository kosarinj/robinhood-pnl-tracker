import { useEffect } from 'react'
import { useSettings } from '../contexts/SettingsContext'

// A fixed, full-screen background image sitting behind the whole app, with an
// adjustable fade (opacity), optional blur, and an optional color tint on top.
// When active, `body.has-bg` makes the app container transparent (see index.css) so
// the image shows through behind the content cards.
export default function BackgroundLayer() {
  const { bgUrl, bgOpacity, bgTint, bgBlur } = useSettings()

  useEffect(() => {
    document.body.classList.toggle('has-bg', !!bgUrl)
    return () => document.body.classList.remove('has-bg')
  }, [bgUrl])

  if (!bgUrl) return null
  return (
    <>
      {/* themed base color so the faded image reads consistently in any theme */}
      <div style={{ position: 'fixed', inset: 0, zIndex: -3, background: 'var(--background)', pointerEvents: 'none' }} />
      <div style={{
        position: 'fixed', inset: 0, zIndex: -2,
        backgroundImage: `url(${bgUrl})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        opacity: bgOpacity,
        filter: bgBlur ? `blur(${bgBlur}px)` : 'none',
        pointerEvents: 'none'
      }} />
      {bgTint && bgTint !== 'none' && (
        <div style={{ position: 'fixed', inset: 0, zIndex: -1, background: bgTint, pointerEvents: 'none' }} />
      )}
    </>
  )
}
