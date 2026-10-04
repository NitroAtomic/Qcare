// Loads .env. Older settings named VISIQ_* still work: they are copied to the new VISIQ_* names.
require('dotenv').config({ quiet: true });
for (const k of Object.keys(process.env)) if (k.startsWith('VISIQ_')) { const n = 'VISIQ_' + k.slice(6); if (process.env[n] === undefined) process.env[n] = process.env[k]; }
