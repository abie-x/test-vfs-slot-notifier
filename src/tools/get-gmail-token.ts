import 'dotenv/config';
/**
 * One-time Gmail OAuth2 token generator.
 * Run this once to get a refresh token, then add it to .env.
 *
 * Usage: npm run tools:gmail-token
 */

import * as readline from 'readline';
import { google } from 'googleapis';

const CLIENT_ID     = process.env.GMAIL_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || '';
const REDIRECT_URI  = 'http://localhost';

// We only need read access to Gmail
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

function waitForInput(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

async function main(): Promise<void> {
  const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  // Generate the authorization URL
  const authUrl = auth.generateAuthUrl({
    access_type: 'offline',  // offline = get refresh token
    scope: SCOPES,
    prompt: 'consent',       // force consent screen to ensure refresh token is returned
  });

  console.log('\n════════════════════════════════════════════════════');
  console.log('Open this URL in your browser and authorize access:');
  console.log('════════════════════════════════════════════════════');
  console.log('\n' + authUrl + '\n');
  console.log('════════════════════════════════════════════════════');
  console.log('After authorizing, you will be redirected to localhost.');
  console.log('Copy the "code" parameter from the URL.');
  console.log('Example: http://localhost/?code=4/0AX4XfWi...&scope=...');
  console.log('Copy everything after "code=" and before "&scope"');
  console.log('════════════════════════════════════════════════════\n');

  const code = await waitForInput('Paste the authorization code here: ');

  if (!code) {
    console.error('No code provided. Exiting.');
    process.exit(1);
  }

  try {
    const { tokens } = await auth.getToken(code);

    console.log('\n════════════════════════════════════════════════════');
    console.log('✓ SUCCESS — Add these to your .env file:');
    console.log('════════════════════════════════════════════════════');
    console.log(`GMAIL_CLIENT_ID=${CLIENT_ID}`);
    console.log(`GMAIL_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('════════════════════════════════════════════════════\n');

    if (!tokens.refresh_token) {
      console.warn('⚠ No refresh token returned.');
      console.warn('This happens if you already authorized this app before.');
      console.warn('Go to https://myaccount.google.com/permissions, revoke access');
      console.warn('for this app, then run this script again.');
    }
  } catch (err) {
    console.error('Failed to exchange code for tokens:', err);
    process.exit(1);
  }
}

main();
