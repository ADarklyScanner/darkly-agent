import { readAllLeads } from './sheets.js';
const leads = await readAllLeads();
console.log('HEADERS:');
Object.keys(leads[0]).forEach(h => console.log(' ', JSON.stringify(h)));
