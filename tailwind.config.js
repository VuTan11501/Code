/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./docs/**/*.{html,js}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        primary: { DEFAULT: 'var(--primary)', foreground: 'var(--primary-foreground)' },
        secondary: { DEFAULT: 'var(--secondary)', foreground: 'var(--secondary-foreground)' },
        destructive: { DEFAULT: 'var(--destructive)', foreground: '#ffffff' },
        muted: { DEFAULT: 'var(--muted)', foreground: 'var(--muted-foreground)' },
        accent: { DEFAULT: 'var(--accent)', foreground: 'var(--accent-foreground)' },
        card: { DEFAULT: 'var(--card)', foreground: 'var(--card-foreground)' },
        popover: { DEFAULT: 'var(--card)', foreground: 'var(--card-foreground)' },
        success: { DEFAULT: 'var(--green)', foreground: '#ffffff' },
        warning: { DEFAULT: 'var(--yellow)', foreground: '#1c1917' },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"SF Mono"', '"Fira Code"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        lg: '0.625rem',
        md: '0.5rem',
        sm: '0.375rem',
      },
      keyframes: {
        shimmer: { '0%': { backgroundPosition: '200% 0' }, '100%': { backgroundPosition: '-200% 0' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'modal-in': { from: { opacity: '0', transform: 'scale(0.96) translateY(8px)' }, to: { opacity: '1', transform: 'scale(1) translateY(0)' } },
        'page-in': { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'sheet-up': { from: { transform: 'translateY(100%)' }, to: { transform: 'translateY(0)' } },
        'live-pulse': { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.3' } },
        'status-flash': { '0%': { boxShadow: '0 0 0 3px rgba(59,130,246,0.15)' }, '100%': { boxShadow: 'none' } },
        'picker-slide': { from: { opacity: '0', transform: 'translateY(-6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
      animation: {
        shimmer: 'shimmer 1.8s infinite',
        'fade-in': 'fade-in 150ms ease',
        'modal-in': 'modal-in 300ms cubic-bezier(0.16,1,0.3,1)',
        'page-in': 'page-in 300ms cubic-bezier(0.16,1,0.3,1)',
        'sheet-up': 'sheet-up 300ms cubic-bezier(0.16,1,0.3,1)',
        'live-pulse': 'live-pulse 2s infinite',
        'status-flash': 'status-flash 1s cubic-bezier(0.16,1,0.3,1)',
        'picker-slide': 'picker-slide 200ms cubic-bezier(0.16,1,0.3,1)',
      },
    },
  },
};
