#!/usr/bin/env node
// One-off helper: generates the bcrypt hash to put in ADMIN_PASSWORD_HASH.
// Usage: npm run hash-password -- "your-password-here"
const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Usage: npm run hash-password -- "your-password-here"');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);
console.log(hash);
