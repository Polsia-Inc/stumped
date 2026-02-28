#!/usr/bin/env node
const https = require('https');

const APP_URL = process.env.APP_URL || 'https://stumped.polsia.app';
const TEST_EMAIL = `test-${Date.now()}@example.com`;
const TEST_PASSWORD = 'TestPass123';
const TEST_DISPLAY_NAME = 'Test User';

console.log('🔍 Verifying authentication fix...\n');

function request(method, path, data = null, cookies = '') {
  return new Promise((resolve, reject) => {
    const url = new URL(path, APP_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookies
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const setCookie = res.headers['set-cookie'] || [];
        resolve({
          status: res.statusCode,
          body: body ? JSON.parse(body) : null,
          cookies: setCookie.map(c => c.split(';')[0]).join('; ')
        });
      });
    });

    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function test() {
  try {
    // Step 1: Create test user
    console.log('1️⃣  Creating test user...');
    const signupRes = await request('POST', '/api/auth/signup', {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      displayName: TEST_DISPLAY_NAME
    });

    if (signupRes.status !== 200) {
      throw new Error(`Signup failed: ${signupRes.status}`);
    }

    if (!signupRes.cookies) {
      throw new Error('❌ FAIL: No session cookie set after signup');
    }

    console.log('✅ Signup successful, session cookie set');
    console.log(`   Cookie: ${signupRes.cookies.substring(0, 50)}...`);

    // Step 2: Verify /api/auth/me with session cookie
    console.log('\n2️⃣  Checking /api/auth/me with session cookie...');
    const meRes = await request('GET', '/api/auth/me', null, signupRes.cookies);

    if (meRes.status !== 200) {
      throw new Error(`❌ FAIL: /api/auth/me returned ${meRes.status} - session not working`);
    }

    if (!meRes.body.user || meRes.body.user.email !== TEST_EMAIL) {
      throw new Error('❌ FAIL: User data mismatch');
    }

    console.log('✅ Session authenticated successfully');
    console.log(`   User: ${meRes.body.user.displayName} (${meRes.body.user.email})`);

    // Step 3: Verify dashboard API endpoint
    console.log('\n3️⃣  Checking /api/dashboard/my-quizzes...');
    const dashboardRes = await request('GET', '/api/dashboard/my-quizzes', null, signupRes.cookies);

    if (dashboardRes.status !== 200) {
      throw new Error(`❌ FAIL: Dashboard API returned ${dashboardRes.status}`);
    }

    console.log('✅ Dashboard API working');
    console.log(`   Quizzes: ${dashboardRes.body.quizzes.length}`);

    // Step 4: Test logout
    console.log('\n4️⃣  Testing logout...');
    const logoutRes = await request('POST', '/api/auth/logout', null, signupRes.cookies);

    if (logoutRes.status !== 200) {
      throw new Error(`❌ FAIL: Logout failed: ${logoutRes.status}`);
    }

    console.log('✅ Logout successful');

    // Step 5: Verify session is destroyed
    console.log('\n5️⃣  Verifying session destroyed after logout...');
    const meAfterLogout = await request('GET', '/api/auth/me', null, signupRes.cookies);

    if (meAfterLogout.status !== 401) {
      throw new Error(`❌ FAIL: Session still valid after logout (got ${meAfterLogout.status})`);
    }

    console.log('✅ Session properly destroyed');

    console.log('\n🎉 SUCCESS! Authentication is working correctly!');
    console.log('\nThe dashboard should now work properly:');
    console.log(`   1. Go to ${APP_URL}/signup.html`);
    console.log('   2. Create an account');
    console.log('   3. You\'ll be redirected to /dashboard');
    console.log('   4. Dashboard should load your quizzes (empty for new users)');

    process.exit(0);

  } catch (err) {
    console.error('\n❌ VERIFICATION FAILED:', err.message);
    process.exit(1);
  }
}

test();
