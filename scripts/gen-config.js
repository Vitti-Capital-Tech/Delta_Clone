/* Vercel build step: writes js/config.js from the BACKEND_URL environment variable, so the real server
   address is set in Vercel's dashboard and never committed. If BACKEND_URL is unset the file is left as is. */
const fs = require('fs');
const url = (process.env.BACKEND_URL || '').trim().replace(/\/+$/, '');
if (!url) { console.log('BACKEND_URL not set: leaving js/config.js unchanged'); process.exit(0); }
fs.writeFileSync('js/config.js', `window.APP_CONFIG = { backend: ${JSON.stringify(url)} };\n`);
console.log('js/config.js written for backend', url);
