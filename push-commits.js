const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');
const fs = require('fs');

async function pushToRemote() {
  try {
    // Read git config to get remote URL
    const config = fs.readFileSync('.git/config', 'utf8');
    const urlMatch = config.match(/url = (.*)/);

    if (!urlMatch) {
      console.error('Could not find remote URL in .git/config');
      process.exit(1);
    }

    const remoteUrl = urlMatch[1];
    console.log('Remote URL:', remoteUrl.replace(/\/\/.*@/, '//***@'));

    // Extract token if present in URL
    const tokenMatch = remoteUrl.match(/\/\/x-access-token:([^@]+)@/);
    let token = tokenMatch ? tokenMatch[1] : process.env.GITHUB_TOKEN;

    if (!token) {
      console.error('No GitHub token found in remote URL or GITHUB_TOKEN env var');
      process.exit(1);
    }

    console.log('Token found, attempting push...');

    await git.push({
      fs,
      http,
      dir: '.',
      remote: 'origin',
      ref: 'main',
      onAuth: () => ({
        username: 'x-access-token',
        password: token
      }),
      onAuthFailure: ({ url, auth }) => {
        console.error('Auth failed for:', url);
        return { cancel: true };
      }
    });

    console.log('✓ Push successful!');
  } catch (err) {
    console.error('Push failed:', err.message);
    process.exit(1);
  }
}

pushToRemote();
