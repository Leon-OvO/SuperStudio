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
      }
    }
  },
  plugins: [require('@tailwindcss/typography')]
}
