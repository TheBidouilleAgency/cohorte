import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './features/shell/App';
import { applyTheme, initialTheme } from './lib/theme';
import './styles/tokens.css';
import './styles/app.css';

applyTheme(initialTheme());
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
