#!/usr/bin/env node
// Usage: npm run hash-password -- "your-chosen-password"
const bcrypt = require("bcryptjs");

const pw = process.argv[2];
if (!pw) {
  console.error('Usage: npm run hash-password -- "your-chosen-password"');
  process.exit(1);
}
const hash = bcrypt.hashSync(pw, 12);
console.log("\nPaste this into .env as ADMIN_PASSWORD_HASH:\n");
console.log(hash);
console.log("");
