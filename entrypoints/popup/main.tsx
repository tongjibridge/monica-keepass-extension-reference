import React from 'react';
import ReactDOM from 'react-dom/client';
import { TooltipProvider } from '@/src/components/ui/tooltip';
import { App } from './App';
import './style.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={300}>
      <App />
    </TooltipProvider>
  </React.StrictMode>,
);
