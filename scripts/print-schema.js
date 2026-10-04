// Prints the database schema (tables, indexes, row-level security) so you can paste it into the Supabase SQL editor.
console.log('-- QCare database schema for Supabase. Safe to run more than once.\n-- QCare also runs this automatically every time it starts, so pasting it is optional.\n');
console.log(require('../server/schema').FULL);
