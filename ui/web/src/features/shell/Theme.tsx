import { Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { applyTheme, initialTheme, type Theme } from '../../lib/theme';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === 'light' ? 'light' : initialTheme());
  const flip = () => { const t: Theme = theme === 'dark' ? 'light' : 'dark'; applyTheme(t); setTheme(t); };
  return (
    <button type="button" className="btn icon" onClick={flip} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title="Toggle theme">
      {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
    </button>
  );
}
