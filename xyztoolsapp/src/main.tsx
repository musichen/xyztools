import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import faviconUrl from '../assets/logo/xyztools_logo.png';
import './styles.css';

const favicon = document.createElement('link');
favicon.rel = 'icon';
favicon.type = 'image/png';
favicon.href = faviconUrl;
document.head.appendChild(favicon);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
