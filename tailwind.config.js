/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: ['./index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Bumped one notch from Tailwind defaults so the app reads comfortably
      // at desktop viewing distance. Old defaults felt cramped (text-xs = 12px,
      // text-sm = 14px). Now: xs = 13, sm = 15, base = 16, lg = 18, xl = 20.
      fontSize: {
        'xs':   ['0.8125rem', { lineHeight: '1.15rem' }],   // 13px / 18.4px
        'sm':   ['0.9375rem', { lineHeight: '1.4rem' }],    // 15px / 22.4px
        'base': ['1rem',      { lineHeight: '1.55rem' }],   // 16px / 24.8px
        'lg':   ['1.125rem',  { lineHeight: '1.7rem' }],    // 18px / 27.2px
        'xl':   ['1.25rem',   { lineHeight: '1.85rem' }],   // 20px / 29.6px
        '2xl':  ['1.5rem',    { lineHeight: '2.1rem' }],    // 24px / 33.6px
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))'
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))'
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))'
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar))',
          foreground: 'hsl(var(--sidebar-foreground))',
          border: 'hsl(var(--sidebar-border))'
        }
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)'
      },
      // macOS-style shadows: soft, diffuse, low-opacity (replaces Tailwind's harder
      // defaults app-wide — every shadow-sm/md/lg/xl/2xl picks up the softer look).
      boxShadow: {
        sm: '0 1px 2px rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.05)',
        DEFAULT: '0 2px 8px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        md: '0 4px 16px rgba(0,0,0,0.07), 0 2px 4px rgba(0,0,0,0.04)',
        lg: '0 10px 30px rgba(0,0,0,0.10), 0 3px 8px rgba(0,0,0,0.05)',
        xl: '0 18px 50px rgba(0,0,0,0.14), 0 6px 14px rgba(0,0,0,0.06)',
        '2xl': '0 28px 70px rgba(0,0,0,0.20)'
      },
      // macOS-style overlay entrances: backdrops fade, dialogs spring-scale from
      // slightly small + low, popovers/menus scale from their edge. Short + ease-out
      // so it reads as snappy, not sluggish.
      keyframes: {
        'overlay-in': {
          from: { opacity: '0' },
          to: { opacity: '1' }
        },
        'dialog-in': {
          from: { opacity: '0', transform: 'scale(0.96) translateY(8px)' },
          to: { opacity: '1', transform: 'scale(1) translateY(0)' }
        },
        'popover-in': {
          from: { opacity: '0', transform: 'scale(0.97) translateY(-4px)' },
          to: { opacity: '1', transform: 'scale(1) translateY(0)' }
        },
        'menu-in': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' }
        },
        'toast-in': {
          from: { opacity: '0', transform: 'translateX(16px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateX(0) scale(1)' }
        },
        // One-shot celebration for a just-auto-learned skill chip: a gentle
        // scale + glow burst that settles. Kept short so it reads as a "刚学会"
        // celebration, not a distracting infinite pulse.
        'skill-pop': {
          '0%': { transform: 'scale(0.92)', boxShadow: '0 0 0 0 hsl(var(--primary) / 0)' },
          '45%': { transform: 'scale(1.05)', boxShadow: '0 0 14px 2px hsl(var(--primary) / 0.45)' },
          '100%': { transform: 'scale(1)', boxShadow: '0 0 0 0 hsl(var(--primary) / 0)' }
        }
      },
      animation: {
        'overlay-in': 'overlay-in 0.18s ease-out',
        'dialog-in': 'dialog-in 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        'popover-in': 'popover-in 0.15s cubic-bezier(0.16, 1, 0.3, 1)',
        'menu-in': 'menu-in 0.13s cubic-bezier(0.16, 1, 0.3, 1)',
        'toast-in': 'toast-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
        'skill-pop': 'skill-pop 0.6s cubic-bezier(0.16, 1, 0.3, 1)'
      }
    }
  },
  plugins: [require('@tailwindcss/typography')]
}
