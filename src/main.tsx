import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installWebCstLoader } from './ui/cst-web';
import './styles.css';

installWebCstLoader();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
