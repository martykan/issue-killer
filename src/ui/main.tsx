import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

// Inside the Electrobun desktop app: enables the unified toolbar styling.
if ('__electrobunWindowId' in window) document.documentElement.classList.add('desktop');

createRoot(document.getElementById('root')!).render(<App />);
